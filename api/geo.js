// POST /api/geo  — two modes, both staff-JWT-authed, both need GOOGLE_MAPS_API_KEY (else 501):
//   geocode: { items:[{id, address}] }          → { results:[{id, lat, lng}] }  (map pins)
//   route:   { mode:'route', origin, stops[], optimize? } → { distanceKm, durationMin, order[] }
// Geocoding is region-biased to Malaysia; items Google can't resolve are omitted. Route mode
// uses the Routes API computeRoutes for totals + optional shortest-distance stop ordering.
// Without GOOGLE_MAPS_API_KEY the endpoint answers 501 and the app shows a hint
// instead of pins (the driver page still fully works from the list).
//
// Cost note: one request per NEW order address, cached forever in orders.lat/lng by the
// caller — ~300/month vs Google's 10,000 free Essentials calls (see driver-mode plan).

const SB_URL  = process.env.SUPABASE_URL  || 'https://oyrngwazbqmxoeihyfoy.supabase.co';
const SB_ANON = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im95cm5nd2F6YnFteG9laWh5Zm95Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA3MzQ1MjksImV4cCI6MjA5NjMxMDUyOX0.SFySJvTDJCa2in9r_Rvvg5akPMEhGloCS6H08RtPOPE';

async function verifyStaff(jwt) {
  if (!jwt) return false;
  try {
    const r = await fetch(`${SB_URL}/auth/v1/user`, { headers: { apikey: SB_ANON, Authorization: `Bearer ${jwt}` } });
    if (!r.ok) return false;
    const u = await r.json().catch(() => null);
    return !!(u && u.id);
  } catch { return false; }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const KEY = process.env.GOOGLE_MAPS_API_KEY;
  if (!KEY) return res.status(501).json({ error: 'geo_not_configured' });

  let body = {};
  try { body = typeof req.body === 'object' && req.body ? req.body : JSON.parse(req.body || '{}'); } catch {}
  const jwt = body.authToken || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!(await verifyStaff(jwt))) return res.status(401).json({ error: 'Not authenticated' });

  // ── Route mode: distance/time totals + optional waypoint optimization ──
  // body { mode:'route', origin:{lat,lng}, stops:[{id,lat,lng}], optimize?:bool }
  // Round trip shop → stops → shop (a driver's typical loop). Returns total distance +
  // duration, and (when optimize) the stop ids in the shortest-distance order.
  if (body.mode === 'route') {
    const origin = body.origin && typeof body.origin.lat === 'number' ? body.origin : null;
    const stops = (Array.isArray(body.stops) ? body.stops : [])
      .filter(s => s && s.id != null && typeof s.lat === 'number' && typeof s.lng === 'number').slice(0, 25);
    if (!origin || !stops.length) return res.status(400).json({ error: 'origin + stops required' });
    const optimize = !!body.optimize;
    const pt = p => ({ location: { latLng: { latitude: p.lat, longitude: p.lng } } });
    const payload = {
      origin: pt(origin), destination: pt(origin),
      intermediates: stops.map(pt),
      travelMode: 'DRIVE', optimizeWaypointOrder: optimize,
    };
    try {
      const r = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': KEY,
          'X-Goog-FieldMask': 'routes.distanceMeters,routes.duration,routes.optimizedIntermediateWaypointIndex,routes.polyline.encodedPolyline',
        },
        body: JSON.stringify(payload),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.routes || !j.routes[0]) {
        return res.status(200).json({ error: (j.error && j.error.message) || ('routes HTTP ' + r.status) });
      }
      const rt = j.routes[0];
      const distanceKm = Math.round((rt.distanceMeters || 0) / 100) / 10;             // 1 dp
      const durationMin = Math.round(parseInt(String(rt.duration || '0'), 10) / 60);   // "1234s" → min
      const idx = rt.optimizedIntermediateWaypointIndex;
      const order = (optimize && Array.isArray(idx)) ? idx.map(i => stops[i].id) : stops.map(s => s.id);
      const polyline = (rt.polyline && rt.polyline.encodedPolyline) || null;
      return res.status(200).json({ distanceKm, durationMin, order, polyline });
    } catch (e) {
      return res.status(200).json({ error: String(e && e.message || e) });
    }
  }

  // ── Places autocomplete: type-ahead address suggestions (needs Places API enabled) ──
  // body { mode:'autocomplete', input, sessionToken? } → { predictions:[{description, placeId}] }
  if (body.mode === 'autocomplete') {
    const input = String(body.input || '').trim();
    if (input.length < 3) return res.status(200).json({ predictions: [] });
    try {
      const u = 'https://maps.googleapis.com/maps/api/place/autocomplete/json?input='
        + encodeURIComponent(input) + '&components=country:my&language=en&key=' + KEY
        + (body.sessionToken ? '&sessiontoken=' + encodeURIComponent(String(body.sessionToken)) : '');
      const r = await fetch(u); const j = await r.json().catch(() => ({}));
      if (j.status && j.status !== 'OK' && j.status !== 'ZERO_RESULTS') return res.status(200).json({ error: j.error_message || j.status, predictions: [] });
      const predictions = (j.predictions || []).slice(0, 6).map(p => ({ description: p.description, placeId: p.place_id }));
      return res.status(200).json({ predictions });
    } catch (e) { return res.status(200).json({ error: String(e && e.message || e), predictions: [] }); }
  }
  // ── Place details: resolve a chosen suggestion to coordinates + a clean address ──
  // body { mode:'place', placeId, sessionToken? } → { lat, lng, address }
  if (body.mode === 'place') {
    const pid = String(body.placeId || '').trim();
    if (!pid) return res.status(400).json({ error: 'placeId required' });
    try {
      const u = 'https://maps.googleapis.com/maps/api/place/details/json?place_id='
        + encodeURIComponent(pid) + '&fields=geometry,formatted_address&language=en&key=' + KEY
        + (body.sessionToken ? '&sessiontoken=' + encodeURIComponent(String(body.sessionToken)) : '');
      const r = await fetch(u); const j = await r.json().catch(() => ({}));
      const loc = j && j.result && j.result.geometry && j.result.geometry.location;
      if (!loc || typeof loc.lat !== 'number') return res.status(200).json({ error: (j.error_message || j.status || 'no_geometry') });
      return res.status(200).json({ lat: loc.lat, lng: loc.lng, address: (j.result.formatted_address || null) });
    } catch (e) { return res.status(200).json({ error: String(e && e.message || e) }); }
  }

  const items = (Array.isArray(body.items) ? body.items : []).slice(0, 30)
    .filter(x => x && x.id != null && typeof x.address === 'string' && x.address.trim());
  if (!items.length) return res.status(400).json({ error: 'items required' });

  const results = [];
  for (const it of items) {
    try {
      const g = await geocodeAddress(it.address, KEY);
      if (g) results.push({ id: String(it.id), lat: g.lat, lng: g.lng });
    } catch (_) { /* skip this address; the pin just won't show */ }
  }
  return res.status(200).json({ results });
}

async function _geo1(addr, KEY) {
  const u = 'https://maps.googleapis.com/maps/api/geocode/json?address='
    + encodeURIComponent(addr) + '&region=my&components=country:MY&key=' + KEY;
  const r = await fetch(u); const j = await r.json().catch(() => ({}));
  const loc = j && j.results && j.results[0] && j.results[0].geometry && j.results[0].geometry.location;
  return (loc && typeof loc.lat === 'number') ? { lat: loc.lat, lng: loc.lng } : null;
}
// Try the full address; if Google can't match it, retry with cleaner variants: drop a leading
// business-name segment (everything before the first part that has a digit — usually the street
// number), then fall back to postcode + town. Fixes "Shop Name, 240 Lebuh Pantai, 10300 George
// Town" which Geocoding rejects as-is but resolves once the shop name is removed.
async function geocodeAddress(address, KEY) {
  const full = String(address || '').trim();
  if (!full) return null;
  const tries = [full];
  const parts = full.split(',').map(s => s.trim()).filter(Boolean);
  const iDigit = parts.findIndex(p => /\d/.test(p));
  if (iDigit > 0) tries.push(parts.slice(iDigit).join(', '));
  const pc = full.match(/\b(\d{5})\b\s*([A-Za-z .,'’-]+)?/);
  if (pc) tries.push((pc[1] + (pc[2] ? ' ' + pc[2].trim().replace(/,.*$/, '') : '') + ', Malaysia'));
  const seen = new Set();
  for (const t of tries) {
    const k = t.toLowerCase(); if (seen.has(k)) continue; seen.add(k);
    try { const g = await _geo1(t, KEY); if (g) return g; } catch (_) {}
  }
  return null;
}
