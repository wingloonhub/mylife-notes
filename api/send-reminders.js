// ============================================================
//  MyLife Hub — reminder sender (Vercel serverless function)
// ============================================================
//  Runs on a timer (pinged every ~15 min). For each configured user it logs in
//  as that user (Firebase Auth REST — no service-account key needed), reads ONLY
//  that user's events/to-dos + Telegram settings, and sends due reminders to their
//  Telegram. Each user's data stays private (each login only unlocks its own data).
//
//  Ping URL:  https://<your-site>/api/send-reminders?key=YOUR_CRON_SECRET
//
//  Vercel environment variables:
//    MLN_USERS    (required) JSON: [{"email":"you@x.com","password":"..."},{"email":"wife@x.com","password":"..."}]
//    CRON_SECRET  (required) any random string; must match ?key= in the ping URL
//    FB_API_KEY   (optional) Firebase web apiKey  (defaults to the project's public key below)
//    FB_PROJECT   (optional) Firebase project id  (default "mylife-notes")
//    TZ_OFFSET_MIN(optional) minutes east of UTC for local time (default 480 = Malaysia)
// ============================================================

const DEFAULT_API_KEY = 'AIzaSyAPWqJaH3hexwmO0PjtzUf17I-FpyLDO-A';
const DEFAULT_PROJECT = 'mylife-notes';

/* ---- Firestore REST value <-> JS ---- */
function toFs(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'string') return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toFs) } };
  if (typeof v === 'object') { const fields = {}; for (const k in v) fields[k] = toFs(v[k]); return { mapValue: { fields } }; }
  return { stringValue: String(v) };
}
function fromFs(val) {
  if (!val) return null;
  if ('nullValue' in val) return null;
  if ('booleanValue' in val) return val.booleanValue;
  if ('integerValue' in val) return parseInt(val.integerValue, 10);
  if ('doubleValue' in val) return val.doubleValue;
  if ('stringValue' in val) return val.stringValue;
  if ('timestampValue' in val) return val.timestampValue;
  if ('arrayValue' in val) return (val.arrayValue.values || []).map(fromFs);
  if ('mapValue' in val) { const o = {}; const f = val.mapValue.fields || {}; for (const k in f) o[k] = fromFs(f[k]); return o; }
  return null;
}

async function signIn(email, password, apiKey) {
  const r = await fetch('https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=' + apiKey, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, returnSecureToken: true })
  });
  const j = await r.json();
  if (!j.idToken) throw new Error('login failed: ' + ((j.error && j.error.message) || 'unknown'));
  return { idToken: j.idToken, uid: j.localId };
}
async function listItems(project, uid, idToken) {
  const out = [];
  let pageToken = '';
  do {
    let url = `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents/users/${uid}/items?pageSize=300`;
    if (pageToken) url += '&pageToken=' + encodeURIComponent(pageToken);
    const r = await fetch(url, { headers: { Authorization: 'Bearer ' + idToken } });
    const j = await r.json();
    (j.documents || []).forEach(d => {
      const o = { id: d.name.split('/').pop() };
      for (const k in (d.fields || {})) o[k] = fromFs(d.fields[k]);
      out.push(o);
    });
    pageToken = j.nextPageToken || '';
  } while (pageToken);
  return out;
}
async function patchData(project, uid, idToken, id, data) {
  const url = `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents/users/${uid}/items/${id}?updateMask.fieldPaths=data`;
  await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + idToken },
    body: JSON.stringify({ fields: { data: toFs(data) } })
  });
}
async function tg(token, chatId, text) {
  await fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text })
  });
}

/* ---- date helpers (interpret the app's naive local times in the user's tz) ---- */
function naiveToUTC(s, offMin) {
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return NaN;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) - offMin * 60000;
}
function dateStrInTz(ms, offMin) {
  const d = new Date(ms + offMin * 60000), p = n => String(n).padStart(2, '0');
  return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate());
}
function dateMinusDays(dateStr, days) {
  const [Y, M, D] = dateStr.split('-').map(Number);
  const d = new Date(Date.UTC(Y, M - 1, D)); d.setUTCDate(d.getUTCDate() - days);
  const p = n => String(n).padStart(2, '0');
  return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate());
}
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function fmtDateTime(ms, offMin) {
  const d = new Date(ms + offMin * 60000), p = n => String(n).padStart(2, '0');
  let h = d.getUTCHours(), ap = h < 12 ? 'AM' : 'PM'; h = h % 12 || 12;
  return DAY[d.getUTCDay()] + ', ' + d.getUTCDate() + ' ' + MON[d.getUTCMonth()] + ', ' + h + ':' + p(d.getUTCMinutes()) + ' ' + ap;
}
function fmtDateOnly(dateStr) {
  const [Y, M, D] = dateStr.split('-').map(Number);
  return D + ' ' + MON[M - 1] + ' ' + Y;
}

async function processUser(u, apiKey, project, offMin, now) {
  const { idToken, uid } = await signIn(u.email, u.password, apiKey);
  const items = await listItems(project, uid, idToken);
  const settings = (items.find(i => i.cat === '_settings') || {}).data || {};
  const token = settings.telegramToken, chat = settings.telegramChatId;
  if (!token || !chat) return { skipped: 'no Telegram configured in Settings' };
  const userOff = (typeof settings.tzOffset === 'number') ? settings.tzOffset : offMin;
  const leadMs = (settings.leadMinutes || 60) * 60000;
  const todoLeadDays = Math.max(0, settings.todoLeadDays || 0);
  let sent = 0;

  // events
  for (const it of items.filter(i => i.cat === 'events')) {
    const d = it.data || {};
    if (!d.when) continue;
    const t = naiveToUTC(d.when, userOff);
    if (isNaN(t)) continue;
    if (now >= t - leadMs && now < t && d._notifiedFor !== d.when) {
      const mins = Math.round((t - now) / 60000);
      const body = (mins > 0 ? ('In about ' + mins + ' min' + (d.location ? ' · ' + d.location : '')) : 'Starting now') + ' · ' + fmtDateTime(t, userOff);
      await tg(token, chat, '⏰ ' + (d.title || 'Event') + '\n' + body);
      d._notifiedFor = d.when;
      await patchData(project, uid, idToken, it.id, d);
      sent++;
    }
  }

  // to-dos (per-item due dates)
  const todayStr = dateStrInTz(now, userOff);
  for (const it of items.filter(i => i.cat === 'todo')) {
    const d = it.data || {};
    const arr = d.items || [];
    const toSend = [];
    arr.forEach(task => {
      if (!task.eta || task.checked) return;
      const startStr = dateMinusDays(task.eta, todoLeadDays);
      if (todayStr >= startStr && todayStr <= task.eta && task._notified !== todayStr) {
        const daysLeft = Math.round((Date.parse(task.eta + 'T00:00:00Z') - Date.parse(todayStr + 'T00:00:00Z')) / 86400000);
        toSend.push({ task, body: daysLeft > 0 ? ('Due in ' + daysLeft + ' day' + (daysLeft > 1 ? 's' : '')) : 'Due today' });
      }
    });
    for (const s of toSend) {
      await tg(token, chat, '✅ ' + (s.task.name || 'To-do') + ' — due ' + fmtDateOnly(s.task.eta) + '\n' + s.body);
      s.task._notified = todayStr;
      sent++;
    }
    if (toSend.length) await patchData(project, uid, idToken, it.id, d);
  }

  return { uid, sent };
}

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  const secret = process.env.CRON_SECRET;
  const key = (req.query && req.query.key) || '';
  if (secret && key !== secret) { res.status(401).json({ error: 'unauthorized' }); return; }
  const apiKey = process.env.FB_API_KEY || DEFAULT_API_KEY;
  const project = process.env.FB_PROJECT || DEFAULT_PROJECT;
  const offMin = parseInt(process.env.TZ_OFFSET_MIN || '480', 10);
  let users = [];
  try { users = JSON.parse(process.env.MLN_USERS || '[]'); }
  catch (e) { res.status(500).json({ error: 'MLN_USERS is not valid JSON' }); return; }
  const now = Date.now();
  const results = [];
  for (const u of users) {
    try { results.push({ email: u.email, ...(await processUser(u, apiKey, project, offMin, now)) }); }
    catch (e) { results.push({ email: u.email, error: String((e && e.message) || e) }); }
  }
  res.status(200).json({ ok: true, ranAt: new Date(now).toISOString(), results });
};
