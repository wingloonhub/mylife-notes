// ============================================================
//  MyLife Hub — Premier League proxy (Vercel serverless)
// ============================================================
//  Fetches matches / standings from football-data.org and returns the raw JSON.
//  Keeps the API token server-side (never exposed to the browser) and adds a
//  short edge cache so opening the screen doesn't blow the free rate limit.
//
//  Ping URLs (used by the app):
//    /api/worldcup?type=matches
//    /api/worldcup?type=standings
//
//  Vercel environment variable:
//    FOOTBALL_API_KEY  (required) free token from https://www.football-data.org/client/register
// ============================================================

const COMP = 'PL'; // football-data.org competition code for the English Premier League

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  // edge cache: serve the same response for 30s, allow a stale copy for 60s while revalidating
  res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');

  const key = process.env.FOOTBALL_API_KEY;
  if (!key) {
    res.status(200).json({ error: 'no-key', message: 'Football data is not set up yet.' });
    return;
  }
  const q = req.query || {};
  let path;
  if (q.type === 'standings') path = 'competitions/' + COMP + '/standings';
  else if (q.type === 'clstandings') path = 'competitions/CL/standings';       // Champions League table
  else if (q.type === 'team' && /^\d+$/.test(String(q.id || ''))) path = 'teams/' + q.id + '/matches'; // one club, all feed competitions
  else path = 'competitions/' + COMP + '/matches';
  try {
    const r = await fetch('https://api.football-data.org/v4/' + path, {
      headers: { 'X-Auth-Token': key }
    });
    const j = await r.json();
    if (!r.ok) { res.status(200).json({ error: 'api-error', message: (j && j.message) || ('HTTP ' + r.status) }); return; }
    res.status(200).json(j);
  } catch (e) {
    res.status(200).json({ error: 'fetch-failed', message: String((e && e.message) || e) });
  }
};
