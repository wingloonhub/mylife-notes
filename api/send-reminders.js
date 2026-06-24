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
async function putItem(project, uid, idToken, id, cat, data) {
  const url = `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents/users/${uid}/items/${id}?updateMask.fieldPaths=cat&updateMask.fieldPaths=data`;
  await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + idToken },
    body: JSON.stringify({ fields: { cat: toFs(cat), data: toFs(data) } })
  });
}
async function deleteItem(project, uid, idToken, id) {
  await fetch(`https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents/users/${uid}/items/${id}`,
    { method: 'DELETE', headers: { Authorization: 'Bearer ' + idToken } });
}
/* ---- shared collection (live-shared items: schedules, activities, etc.) ---- */
async function listShared(project, idToken, email) {
  const url = `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents:runQuery`;
  const body = { structuredQuery: { from: [{ collectionId: 'shared' }], where: { fieldFilter: { field: { fieldPath: 'participants' }, op: 'ARRAY_CONTAINS', value: { stringValue: email } } } } };
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + idToken }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => []);
  const out = [];
  (Array.isArray(j) ? j : []).forEach(row => {
    if (!row.document) return;
    const o = { id: row.document.name.split('/').pop(), _shared: true };
    for (const k in (row.document.fields || {})) o[k] = fromFs(row.document.fields[k]);
    out.push(o);
  });
  return out;
}
async function putShared(project, idToken, id, fields) {
  const masks = Object.keys(fields).map(k => 'updateMask.fieldPaths=' + k).join('&');
  const fsFields = {}; for (const k in fields) fsFields[k] = toFs(fields[k]);
  await fetch(`https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents/shared/${id}?${masks}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + idToken }, body: JSON.stringify({ fields: fsFields })
  });
}
async function deleteShared(project, idToken, id) {
  await fetch(`https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents/shared/${id}`, { method: 'DELETE', headers: { Authorization: 'Bearer ' + idToken } });
}

/* materialise the next 7 days of activities from the schedule definitions (idempotent). A shared schedule makes a SHARED activity. */
async function ensureActivities(project, uid, email, idToken, items, now, offMin) {
  const today = dateStrInTz(now, offMin);
  let acts = items.filter(i => i.cat === 'activity');
  const have = new Set(acts.map(a => a.id));
  const jobs = [];
  for (const a of acts) { if (((a.data && a.data.date) || '') < today) jobs.push(a._shared ? deleteShared(project, idToken, a.id) : deleteItem(project, uid, idToken, a.id)); }
  acts = acts.filter(a => ((a.data && a.data.date) || '') >= today);
  const schedules = items.filter(i => i.cat === 'schedule');
  for (let off = 0; off < 7; off++) {
    const dayMs = now + off * 86400000;
    const dateStr = dateStrInTz(dayMs, offMin);
    const dow = new Date(dayMs + offMin * 60000).getUTCDay();
    for (const sc of schedules) {
      const d = sc.data || {};
      (d.slots || []).forEach((slot, idx) => {
        if (Number(slot.day) !== dow) return;
        if (d.repeatMode === 'until' && d.until && dateStr > d.until) return;
        const id = sc.id + '__' + dateStr + '__' + idx;
        if (have.has(id)) return;
        have.add(id);
        const data = { scheduleId: sc.id, title: d.title || 'Activity', location: d.location || '', lat: d.lat, lng: d.lng, date: dateStr, start: slot.start || '', end: slot.end || '', startReminder: d.startReminder !== false, startRemindMin: (parseInt(d.startRemindMin, 10) > 0 ? parseInt(d.startRemindMin, 10) : 60), startReminder2: !!d.startReminder2, startRemind2Min: (parseInt(d.startRemind2Min, 10) > 0 ? parseInt(d.startRemind2Min, 10) : 15), endReminder: !!d.endReminder, endRemindMin: (parseInt(d.endRemindMin, 10) > 0 ? parseInt(d.endRemindMin, 10) : 20), cancelled: false };
        const sw = Array.isArray(d.sharedWith) ? d.sharedWith.map(e => String(e).trim().toLowerCase()).filter(Boolean) : [];
        if (sw.length) {
          const ownerEmail = sc.ownerEmail || email;
          const ownerUid = sc.ownerUid || uid;
          data.sharedWith = sw;
          const participants = Array.from(new Set([ownerEmail, ...sw]));
          jobs.push(putShared(project, idToken, id, { cat: 'activity', data, ownerUid, ownerEmail, participants }));
          acts.push({ id, cat: 'activity', data, _shared: true, ownerUid, ownerEmail });
        } else {
          jobs.push(putItem(project, uid, idToken, id, 'activity', data));
          acts.push({ id, cat: 'activity', data });
        }
      });
    }
  }
  await Promise.all(jobs);
  return acts;
}
async function tg(token, chatId, text) {
  const r = await fetch('https://api.telegram.org/bot' + String(token).trim() + '/sendMessage', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: String(chatId).trim(), text })
  });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) throw new Error('Telegram rejected the message: ' + (j.description || ('HTTP ' + r.status)));
  return j;
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
function fmtTime(ms, offMin) {
  const d = new Date(ms + offMin * 60000);
  let h = d.getUTCHours(); const ap = h < 12 ? 'AM' : 'PM'; h = h % 12 || 12;
  return h + ':' + String(d.getUTCMinutes()).padStart(2, '0') + ' ' + ap;
}
function fmtHM12(hm) {
  if (!hm) return '';
  const [h, m] = hm.split(':').map(Number);
  const ap = h < 12 ? 'AM' : 'PM';
  return (h % 12 || 12) + ':' + String(m).padStart(2, '0') + ' ' + ap;
}
// next future UTC ms for weekday dayIdx (0=Sun..6=Sat) at "HH:MM" in the user's local tz
function nextWeekdayOccurrenceUTC(dayIdx, startHM, offMin, now) {
  const [h, m] = startHM.split(':').map(Number);
  const localNow = new Date(now + offMin * 60000);
  const diff = (dayIdx - localNow.getUTCDay() + 7) % 7;
  let occUTC = Date.UTC(localNow.getUTCFullYear(), localNow.getUTCMonth(), localNow.getUTCDate() + diff, h, m) - offMin * 60000;
  if (occUTC <= now) occUTC += 7 * 86400000;
  return occUTC;
}
function trafficFactor(now, offMin) {
  const d = new Date(now + offMin * 60000);
  const wd = d.getUTCDay() >= 1 && d.getUTCDay() <= 5;
  const h = d.getUTCHours() + d.getUTCMinutes() / 60;
  if (wd && h >= 7 && h < 9.5) return 1.6;
  if (wd && h >= 17 && h < 20) return 1.7;
  if (h >= 22 || h < 6) return 1.1;
  return 1.3;
}
async function travelLine(loc, destLat, destLng, now, offMin) {
  if (!loc || typeof loc.lat !== 'number' || typeof destLat !== 'number') return '';
  try {
    const r = await fetch('https://router.project-osrm.org/route/v1/driving/' + loc.lon + ',' + loc.lat + ';' + destLng + ',' + destLat + '?overview=false').then(x => x.json());
    const route = r.routes && r.routes[0];
    if (route) {
      const km = (route.distance / 1000).toFixed(1);
      const mins = Math.max(1, Math.round(route.duration / 60 * trafficFactor(now, offMin)));
      return ` You're about ${km} km away — roughly ${mins} min to get there.`;
    }
  } catch (e) {}
  return '';
}
async function travelMins(loc, destLat, destLng, now, offMin) {
  if (!loc || typeof loc.lat !== 'number' || typeof destLat !== 'number') return null;
  try {
    const r = await fetch('https://router.project-osrm.org/route/v1/driving/' + loc.lon + ',' + loc.lat + ';' + destLng + ',' + destLat + '?overview=false').then(x => x.json());
    const route = r.routes && r.routes[0];
    if (route) return Math.max(1, Math.round(route.duration / 60 * trafficFactor(now, offMin)));
  } catch (e) {}
  return null;
}

async function processUser(u, apiKey, project, offMin, now, debug, tgtest) {
  const { idToken, uid } = await signIn(u.email, u.password, apiKey);
  const email = (u.email || '').trim().toLowerCase();
  const items = await listItems(project, uid, idToken);
  // include live-shared items (shared schedules/activities others shared with me, or mine)
  try { const sh = await listShared(project, idToken, email); for (const si of sh) items.push(si); } catch (e) {}
  const settings = (items.find(i => i.cat === '_settings') || {}).data || {};
  const token = settings.telegramToken, chat = settings.telegramChatId;
  if (tgtest) {
    if (!token || !chat) return { uid, tgtest: 'no Telegram token/chat in Settings' };
    try { await tg(token, chat, '✅ Scheduler test — closed-app reminders can reach this chat.'); return { uid, tgtest: 'SENT OK' }; }
    catch (e) { return { uid, tgtest: 'FAILED', error: String((e && e.message) || e) }; }
  }
  const userOff = (typeof settings.tzOffset === 'number') ? settings.tzOffset : offMin;
  const todoLeadDays = Math.max(0, settings.todoLeadDays || 0);
  // per-card lead time (minutes before start) → ms, with sensible fallback
  const leadMsOf = (d) => (parseInt(d.startRemindMin, 10) > 0 ? parseInt(d.startRemindMin, 10) : 60) * 60000;
  // materialise the next 7 days of activities from the weekly schedule, then drive reminders from those
  const activities = await ensureActivities(project, uid, email, idToken, items, now, userOff);
  if (debug) {
    return {
      uid, nowLocal: new Date(now + userOff * 60000).toISOString().slice(0, 16).replace('T', ' '),
      tzOffset: userOff, telegramSet: !!(token && chat),
      events: items.filter(i => i.cat === 'events').map(it => { const d = it.data || {}; const t = naiveToUTC(d.when, userOff); return { title: d.title, when: d.when, leadMin: leadMsOf(d) / 60000, dueNow: !isNaN(t) && d.startReminder !== false && now >= t - leadMsOf(d) && now < t, alreadyNotified: d._notifiedFor || null }; }),
      activities: activities.map(it => { const d = it.data || {}; const t = naiveToUTC(d.date + 'T' + d.start, userOff); return { title: d.title, date: d.date, start: d.start, leadMin: leadMsOf(d) / 60000, cancelled: !!d.cancelled, dueNow: !isNaN(t) && d.startReminder !== false && now >= t - leadMsOf(d) && now < t, alreadyNotified: d._notifiedFor || null }; })
    };
  }
  if (!token || !chat) return { skipped: 'no Telegram configured in Settings' };
  const loc = (items.find(i => i.cat === '_lastloc') || {}).data; // last-known location from the app
  let sent = 0;

  // events — each event carries its own reminder lead times
  for (const it of items.filter(i => i.cat === 'events')) {
    const d = it.data || {};
    if (!d.when) continue;
    const t = naiveToUTC(d.when, userOff);
    if (isNaN(t) || now >= t) continue;
    const lead1 = leadMsOf(d);
    const lead2 = (parseInt(d.startRemind2Min, 10) > 0 ? parseInt(d.startRemind2Min, 10) : 15) * 60000;
    const mainDue = d.startReminder !== false && now >= t - lead1 && d._notifiedFor !== d.when;
    const secondDue = d.startReminder2 === true && now >= t - lead2 && d._notifiedHalf !== d.when;
    if (!mainDue && !secondDue) continue;
    const mins = Math.round((t - now) / 60000);
    const at = fmtTime(t, userOff);
    const title = d.title || 'your event';
    const travel = (typeof d.lat === 'number') ? await travelLine(loc, d.lat, d.lng, now, userOff) : '';
    if (mainDue) {
      const msg = mins > 0
        ? (`Hey, ${title} is coming up in ${mins} minute${mins === 1 ? '' : 's'}. ` + (d.location ? `Don't forget to be at ${d.location} by ${at}.` : `It starts at ${at}.`))
        : (`Hey, ${title} is starting now${d.location ? ` at ${d.location}` : ''}.`);
      await tg(token, chat, msg + travel);
      d._notifiedFor = d.when;
    }
    if (secondDue) {
      await tg(token, chat, `Hey, are you on your way to ${title}? It's at ${at}.` + travel);
      d._notifiedHalf = d.when;
    }
    await patchData(project, uid, idToken, it.id, d);
    sent++;
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
        toSend.push({ task, due: daysLeft > 0 ? ('due in ' + daysLeft + ' day' + (daysLeft > 1 ? 's' : '')) : 'due today' });
      }
    });
    for (const s of toSend) {
      await tg(token, chat, `Hey, don't forget: ${s.task.name || 'your to-do'} is ${s.due} (${fmtDateOnly(s.task.eta)}).`);
      s.task._notified = todayStr;
      sent++;
    }
    if (toSend.length) await patchData(project, uid, idToken, it.id, d);
  }

  // weekly schedule → reminders from the Upcoming activities (a cancelled day stays silent)
  for (const it of activities) {
    const d = it.data || {};
    if (d.cancelled || !d.date || !d.start) continue;
    const title = d.title || 'your activity';
    const loc2 = (typeof d.lat === 'number') ? await travelLine(loc, d.lat, d.lng, now, userOff) : '';
    let changed = false;
    // "ending soon" reminder — user-set minutes before the end time (e.g. for pick-up)
    if (d.endReminder && d.end) {
      const endLead = (parseInt(d.endRemindMin, 10) > 0 ? parseInt(d.endRemindMin, 10) : 20);
      const endT = naiveToUTC(d.date + 'T' + d.end, userOff);
      if (!isNaN(endT) && now >= endT - endLead * 60000 && now < endT && d._notifiedEnd !== d.date) {
        const em = Math.max(1, Math.round((endT - now) / 60000));
        let endMsg = `${title} will end at ${fmtHM12(d.end)} — about ${em} minute${em === 1 ? '' : 's'} from now.`;
        const tm = (typeof d.lat === 'number') ? await travelMins(loc, d.lat, d.lng, now, userOff) : null;
        if (tm != null) endMsg += `\n\nYou're around ${tm} minute${tm === 1 ? '' : 's'} away, so you still have some time. Maybe start wrapping up and head over soon.`;
        await tg(token, chat, endMsg);
        d._notifiedEnd = d.date; changed = true; sent++;
      }
    }
    // start-based reminders (main + optional 2nd) — each session carries its own lead times
    const t = naiveToUTC(d.date + 'T' + d.start, userOff);
    if (!isNaN(t) && now < t) {
      const lead1 = leadMsOf(d);
      const lead2 = (parseInt(d.startRemind2Min, 10) > 0 ? parseInt(d.startRemind2Min, 10) : 15) * 60000;
      const mainDue = d.startReminder !== false && now >= t - lead1 && d._notifiedFor !== d.date;
      const secondDue = d.startReminder2 === true && now >= t - lead2 && d._notifiedHalf !== d.date;
      if (mainDue || secondDue) {
        const mins = Math.round((t - now) / 60000);
        const at = fmtHM12(d.start);
        if (mainDue) {
          const msg = mins > 0
            ? (`Hey, ${title} is coming up in ${mins} minute${mins === 1 ? '' : 's'}. ` + (d.location ? `Don't forget to be at ${d.location} by ${at}.` : `It starts at ${at}.`))
            : (`Hey, ${title} is starting now${d.location ? ` at ${d.location}` : ''}.`);
          await tg(token, chat, msg + loc2);
          d._notifiedFor = d.date;
        }
        if (secondDue) {
          await tg(token, chat, `Hey, are you on your way to ${title}? It's at ${at}.` + loc2);
          d._notifiedHalf = d.date;
        }
        changed = true; sent++;
      }
    }
    if (changed) {
      if (it._shared) await putShared(project, idToken, it.id, { data: d });
      else await patchData(project, uid, idToken, it.id, d);
    }
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
  const debug = (req.query && req.query.debug) === '1';
  const tgtest = (req.query && req.query.tgtest) === '1';
  const results = [];
  for (const u of users) {
    try { results.push({ email: u.email, ...(await processUser(u, apiKey, project, offMin, now, debug, tgtest)) }); }
    catch (e) { results.push({ email: u.email, error: String((e && e.message) || e) }); }
  }
  res.status(200).json({ ok: true, ranAt: new Date(now).toISOString(), results });
};
