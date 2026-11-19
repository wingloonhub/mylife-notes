// ============================================================
//  MyLife Hub — Strava proxy (Vercel serverless)
// ============================================================
//  Brings your watch's workouts into MyLife Hub.
//
//  The chain is:  watch → Mi Fitness → Strava → this proxy → MyLife Hub
//  Nothing here touches Health Connect or Google, so it works from the web
//  app alone with no phone app in the middle.
//
//  Endpoints:
//    GET  /api/strava?action=authorize   → sends you to Strava's consent page
//    GET  /api/strava?action=callback    → Strava returns here with ?code=…
//    POST /api/strava  { action:'sync', refresh_token, after }  → activities
//
//  Vercel environment variables (both required):
//    STRAVA_CLIENT_ID      from https://www.strava.com/settings/api
//    STRAVA_CLIENT_SECRET  same page — server-side only, never sent to the browser
//
//  Why the client secret lives here and not in app.js: anything in app.js is
//  downloaded by every browser that opens the site. The secret would be in
//  plain sight and anyone could act as this app against your Strava account.
// ============================================================

const AUTHORIZE = 'https://www.strava.com/oauth/authorize';
const TOKEN_URL = 'https://www.strava.com/oauth/token';
const API = 'https://www.strava.com/api/v3';

// activity:read_all also covers activities you've marked "Only you" in Strava.
const SCOPE = 'activity:read_all';

// Must match STRAVA_LS_KEY in app.js — the callback hands the tokens over
// through localStorage on this same origin rather than through the URL, so no
// token is ever written into a query string, browser history or server log.
const LS_KEY = 'mlh_strava_handoff';

const CLOSE_SCRIPT = '</' + 'script>';
const OPEN_SCRIPT = '<' + 'script>';

const origin = (req) => {
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return proto + '://' + host;
};

/* The callback's reply: a bare page that stashes the tokens for the app and
   bounces straight into the Running screen. It never renders long enough to
   read, which is deliberate — there is nothing here for a person to do. */
function handoffPage(payload) {
  const data = JSON.stringify(JSON.stringify(payload)).replace(/</g, '\\u003c');
  return '<!doctype html><html><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>Connecting Strava…</title></head>'
    + '<body style="margin:0;background:#15151c;color:#e9e9f0;font:16px/1.5 system-ui,sans-serif;'
    + 'display:flex;align-items:center;justify-content:center;height:100vh">'
    + '<div>Connecting Strava…</div>'
    + OPEN_SCRIPT
    + 'try{localStorage.setItem(' + JSON.stringify(LS_KEY) + ',' + data + ')}catch(e){}'
    + 'location.replace("/#/cat/running");'
    + CLOSE_SCRIPT
    + '</body></html>';
}

async function exchange(body) {
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j && (j.message || j.error)) || ('HTTP ' + r.status));
  return j;
}

/* One activity, trimmed to what the Running screen actually shows. The full
   Strava payload is ~60 fields; keeping all of it would bloat every Firestore
   write for no visible gain. Heart rate is the reason this whole route exists,
   so it is kept even when null — a missing trace is worth showing as missing. */
function slim(a) {
  return {
    stravaId: a.id,
    name: a.name || 'Activity',
    type: a.sport_type || a.type || 'Workout',
    start: a.start_date || null,            // UTC
    startLocal: a.start_date_local || null, // as the watch recorded it
    distanceM: a.distance || 0,
    movingSec: a.moving_time || 0,
    elapsedSec: a.elapsed_time || 0,
    elevationM: a.total_elevation_gain || 0,
    avgSpeed: a.average_speed || 0,         // m/s
    maxSpeed: a.max_speed || 0,
    hasHr: !!a.has_heartrate,
    avgHr: a.average_heartrate == null ? null : Math.round(a.average_heartrate),
    maxHr: a.max_heartrate == null ? null : Math.round(a.max_heartrate),
    avgCadence: a.average_cadence == null ? null : Math.round(a.average_cadence),
    calories: a.calories == null ? null : Math.round(a.calories),
    isManual: !!a.manual,
    isTrainer: !!a.trainer
  };
}

module.exports = async (req, res) => {
  const clientId = process.env.STRAVA_CLIENT_ID;
  const clientSecret = process.env.STRAVA_CLIENT_SECRET;
  const q = req.query || {};
  const action = q.action || (req.body && req.body.action) || '';

  // ---- 1. Send the browser to Strava's consent page ----------------------
  if (action === 'authorize') {
    if (!clientId) { res.status(200).send('Strava is not set up yet — STRAVA_CLIENT_ID is missing.'); return; }
    const redirect = origin(req) + '/api/strava?action=callback';
    const url = AUTHORIZE
      + '?client_id=' + encodeURIComponent(clientId)
      + '&redirect_uri=' + encodeURIComponent(redirect)
      + '&response_type=code'
      + '&approval_prompt=auto'
      + '&scope=' + encodeURIComponent(SCOPE);
    res.writeHead(302, { Location: url });
    res.end();
    return;
  }

  // ---- 2. Strava sends the browser back here with a one-time code --------
  if (action === 'callback') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    // Strava appends ?error=access_denied when you tap Cancel on its page.
    if (q.error) { res.status(200).send(handoffPage({ error: String(q.error) })); return; }
    if (!q.code) { res.status(200).send(handoffPage({ error: 'no-code' })); return; }
    if (!clientId || !clientSecret) { res.status(200).send(handoffPage({ error: 'not-configured' })); return; }
    try {
      const t = await exchange({
        client_id: clientId,
        client_secret: clientSecret,
        code: String(q.code),
        grant_type: 'authorization_code'
      });
      res.status(200).send(handoffPage({
        refreshToken: t.refresh_token,
        athleteId: t.athlete && t.athlete.id,
        athleteName: t.athlete ? [t.athlete.firstname, t.athlete.lastname].filter(Boolean).join(' ') : '',
        at: Date.now()
      }));
    } catch (e) {
      res.status(200).send(handoffPage({ error: String((e && e.message) || e) }));
    }
    return;
  }

  // ---- 3. Pull activities (the app calls this; tokens travel in the body) --
  if (action === 'sync') {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    if (!clientId || !clientSecret) { res.status(200).json({ error: 'not-configured' }); return; }
    const body = req.body || {};
    const refreshToken = body.refresh_token;
    if (!refreshToken) { res.status(200).json({ error: 'not-connected' }); return; }
    try {
      // Access tokens last six hours, so every sync starts by refreshing.
      const t = await exchange({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token'
      });
      // `after` is an epoch in seconds; the app sends the newest activity it
      // already holds so a routine sync fetches only what is new.
      const after = parseInt(body.after, 10);
      const params = ['per_page=100'];
      if (after > 0) params.push('after=' + after);
      const r = await fetch(API + '/athlete/activities?' + params.join('&'), {
        headers: { Authorization: 'Bearer ' + t.access_token }
      });
      const j = await r.json().catch(() => null);
      if (!r.ok) {
        res.status(200).json({ error: 'api-error', message: (j && j.message) || ('HTTP ' + r.status) });
        return;
      }
      res.status(200).json({
        ok: true,
        // Strava may hand back a different refresh token; storing the old one
        // after that point would lock the app out at the next sync.
        refreshToken: t.refresh_token || refreshToken,
        activities: (Array.isArray(j) ? j : []).map(slim)
      });
    } catch (e) {
      res.status(200).json({ error: 'refresh-failed', message: String((e && e.message) || e) });
    }
    return;
  }

  res.setHeader('Content-Type', 'application/json');
  res.status(200).json({ error: 'unknown-action' });
};
