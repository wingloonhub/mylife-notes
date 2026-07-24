// ============================================================
//  MyLife Hub — Google Places search proxy (Vercel serverless)
// ============================================================
//  Powers the location search box with real Google Maps data (Places API "Text
//  Search (New)"). Keeps the API key server-side; the app calls /api/places?q=…
//  and falls back to the free OSM search if this returns an error.
//
//  Vercel environment variable:
//    GOOGLE_MAPS_KEY  (required) — Google Cloud key with "Places API (New)" enabled
// ============================================================

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate'); // same query → same places
  const key = process.env.GOOGLE_MAPS_KEY;
  if (!key) { res.status(200).json({ error: 'no-key' }); return; }
  const q = ((req.query && req.query.q) || '').trim();
  if (q.length < 2) { res.status(200).json({ places: [] }); return; }
  try {
    const r = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': key,
        'X-Goog-FieldMask': 'places.displayName,places.formattedAddress,places.location'
      },
      body: JSON.stringify({ textQuery: q, regionCode: 'MY', languageCode: 'en', pageSize: 6 })
    });
    const j = await r.json();
    if (!r.ok) { res.status(200).json({ error: 'api-error', message: (j.error && j.error.message) || ('HTTP ' + r.status) }); return; }
    res.status(200).json({
      places: (j.places || []).map(p => ({
        name: (p.displayName && p.displayName.text) || '',
        address: p.formattedAddress || '',
        lat: p.location && p.location.latitude,
        lng: p.location && p.location.longitude
      })).filter(p => typeof p.lat === 'number')
    });
  } catch (e) {
    res.status(200).json({ error: 'fetch-failed', message: String((e && e.message) || e) });
  }
};
