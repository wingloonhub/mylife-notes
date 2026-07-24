// ============================================================
//  MyLife Hub — photo → schedule details (Vercel serverless)
// ============================================================
//  Takes a photo of a flyer / invitation / appointment card / ticket / message
//  screenshot and extracts the event details with an AI vision model.
//  POST /api/scan-schedule  body: { image: <base64 or data-URL jpeg> }
//  → { fields: { title, date, time, endDate, endTime, location, notes } }
//
//  Vercel environment variables (either one works; Claude is preferred if both):
//    ANTHROPIC_API_KEY — Claude API key (sk-ant-…) from console.anthropic.com
//    GEMINI_API_KEY    — Google AI Studio key (AIza…)
// ============================================================

function buildPrompt(today) {
  return 'You are reading a photo of a flyer, invitation, appointment card, ticket or message screenshot. '
    + 'Extract the event details. Today is ' + today + ' (use it to resolve relative or partial dates; assume the NEXT future occurrence). '
    + 'Reply with ONLY a JSON object, no markdown, exactly these keys: '
    + '{"title":"","date":"YYYY-MM-DD","time":"HH:MM","endDate":"YYYY-MM-DD","endTime":"HH:MM","location":"","notes":""}. '
    + 'time/endTime are 24-hour. Leave a value as an empty string if it is not in the image. '
    + 'notes = any other useful details (dress code, doctor name, seat, booking number), one short line.';
}

async function askClaude(key, image, prompt) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001', // fast + cheap, plenty for reading a flyer
      max_tokens: 400,
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: image } },
        { type: 'text', text: prompt }
      ] }]
    })
  });
  const j = await r.json();
  if (!r.ok) throw new Error((j.error && j.error.message) || ('HTTP ' + r.status));
  return ((j.content || [])[0] || {}).text || '';
}

async function askGemini(key, image, prompt) {
  const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=' + key, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: 'image/jpeg', data: image } }] }],
      generationConfig: { temperature: 0 }
    })
  });
  const j = await r.json();
  if (!r.ok) throw new Error((j.error && j.error.message) || ('HTTP ' + r.status));
  const c = ((j.candidates || [])[0] || {}).content;
  return (c && c.parts) ? c.parts.map(p => p.text || '').join('') : '';
}

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }
  const claudeKey = process.env.ANTHROPIC_API_KEY, geminiKey = process.env.GEMINI_API_KEY;
  if (!claudeKey && !geminiKey) { res.status(200).json({ error: 'no-key', message: 'Photo reading is not set up yet (add ANTHROPIC_API_KEY in Vercel).' }); return; }
  let body = req.body;
  try { if (typeof body === 'string') body = JSON.parse(body); } catch (e) { body = null; }
  const image = ((body && body.image) || '').replace(/^data:image\/\w+;base64,/, '');
  if (!image) { res.status(200).json({ error: 'no-image' }); return; }
  // today's date in Malaysia time, so "this Saturday" style dates resolve correctly
  const off = parseInt(process.env.TZ_OFFSET_MIN || '480', 10);
  const today = new Date(Date.now() + off * 60000).toISOString().slice(0, 10);
  const prompt = buildPrompt(today);
  try {
    const text = claudeKey ? await askClaude(claudeKey, image, prompt) : await askGemini(geminiKey, image, prompt);
    const m = text.match(/\{[\s\S]*\}/); // tolerate ```json fences or chatter around the object
    if (!m) { res.status(200).json({ error: 'no-json', message: 'Could not read details from that photo.' }); return; }
    let fields;
    try { fields = JSON.parse(m[0]); } catch (e) { res.status(200).json({ error: 'bad-json' }); return; }
    const clean = s => String(s == null ? '' : s).trim();
    res.status(200).json({ fields: {
      title: clean(fields.title), date: clean(fields.date), time: clean(fields.time),
      endDate: clean(fields.endDate), endTime: clean(fields.endTime),
      location: clean(fields.location), notes: clean(fields.notes)
    } });
  } catch (e) {
    res.status(200).json({ error: 'api-error', message: String((e && e.message) || e) });
  }
};
