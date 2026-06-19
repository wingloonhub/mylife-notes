// Vercel serverless function: resolve a Google Maps link (incl. short share links
// like maps.app.goo.gl) to latitude/longitude by following redirects server-side.
// Called by the app as /api/resolve?url=<google maps link>

function extractCoords(s) {
  if (!s) return null;
  let m = s.match(/@(-?\d{1,3}\.\d+),(-?\d{1,3}\.\d+)/);            // .../@3.07,101.6,17z
  if (m) return [parseFloat(m[1]), parseFloat(m[2])];
  m = s.match(/!3d(-?\d{1,3}\.\d+)!4d(-?\d{1,3}\.\d+)/);            // !3d..!4d..
  if (m) return [parseFloat(m[1]), parseFloat(m[2])];
  m = s.match(/[?&](?:q|query|destination|center|ll)=(-?\d{1,3}\.\d+),(-?\d{1,3}\.\d+)/);
  if (m) return [parseFloat(m[1]), parseFloat(m[2])];
  m = s.match(/[?&]center=(-?\d{1,3}\.\d+)%2C(-?\d{1,3}\.\d+)/i);   // encoded comma
  if (m) return [parseFloat(m[1]), parseFloat(m[2])];
  return null;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const url = req.query && req.query.url;
  if (!url) { res.status(400).json({ error: 'missing url' }); return; }
  try {
    const r = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MyLifeNotes/1.0)' } });
    let coords = extractCoords(r.url);
    if (!coords) {
      const html = await r.text();
      coords = extractCoords(html);
    }
    if (coords) { res.status(200).json({ lat: coords[0], lng: coords[1] }); return; }
    res.status(404).json({ error: 'no coordinates found' });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
};
