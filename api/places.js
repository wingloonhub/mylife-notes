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

// Big venues people actually name a place by ("1 Utama", "KLCC", "Gleneagles"),
// tried first so a car park inside a mall reports the mall, not the access road.
const VENUE_TYPES = ['shopping_mall', 'department_store', 'supermarket', 'hospital', 'airport',
  'stadium', 'university', 'hotel', 'movie_theater', 'convention_center', 'tourist_attraction',
  'train_station', 'subway_station', 'school', 'park'];

const PLACE_FIELDS = 'places.displayName,places.formattedAddress,places.location';

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate'); // same query → same places
  const key = process.env.GOOGLE_MAPS_KEY;
  if (!key) { res.status(200).json({ error: 'no-key' }); return; }

  const shape = (places) => (places || []).map(p => ({
    name: (p.displayName && p.displayName.text) || '',
    address: p.formattedAddress || '',
    lat: p.location && p.location.latitude,
    lng: p.location && p.location.longitude
  })).filter(p => typeof p.lat === 'number');

  // /api/places?type=nearby&lat=…&lng=…  → what building am I standing in?
  if (((req.query && req.query.type) || '') === 'nearby') {
    const lat = parseFloat((req.query && req.query.lat) || ''), lng = parseFloat((req.query && req.query.lng) || '');
    if (!isFinite(lat) || !isFinite(lng)) { res.status(200).json({ error: 'bad-coords' }); return; }
    const search = async (body) => {
      const r = await fetch('https://places.googleapis.com/v1/places:searchNearby', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': PLACE_FIELDS },
        body: JSON.stringify(body)
      });
      const j = await r.json();
      if (!r.ok) throw new Error((j.error && j.error.message) || ('HTTP ' + r.status));
      return shape(j.places);
    };
    const circle = (radius) => ({ locationRestriction: { circle: { center: { latitude: lat, longitude: lng }, radius } },
      maxResultCount: 5, languageCode: 'en' });
    try {
      // a mall swallows its whole footprint, so search wide for a venue before falling back to
      // "whatever is closest" — indoor GPS drifts by a good 50–100 m
      let places = await search(Object.assign(circle(300), { includedTypes: VENUE_TYPES, rankPreference: 'POPULARITY' }));
      if (!places.length) places = await search(Object.assign(circle(120), { rankPreference: 'DISTANCE' }));
      res.status(200).json({ places });
    } catch (e) {
      res.status(200).json({ error: 'api-error', message: String((e && e.message) || e) });
    }
    return;
  }

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
    res.status(200).json({ places: shape(j.places) });
  } catch (e) {
    res.status(200).json({ error: 'fetch-failed', message: String((e && e.message) || e) });
  }
};
