// POST /api/geo  { items:[{id, address}], authToken }
// Geocodes delivery addresses (Google Geocoding API, region-biased to Malaysia) for the
// driver-page map pins. Staff-JWT-authed like api/query.js. Returns
// { results:[{id, lat, lng}] } — items Google can't resolve are simply omitted.
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

  const items = (Array.isArray(body.items) ? body.items : []).slice(0, 30)
    .filter(x => x && x.id != null && typeof x.address === 'string' && x.address.trim());
  if (!items.length) return res.status(400).json({ error: 'items required' });

  const results = [];
  for (const it of items) {
    try {
      const u = 'https://maps.googleapis.com/maps/api/geocode/json?address='
        + encodeURIComponent(it.address) + '&region=my&components=country:MY&key=' + KEY;
      const r = await fetch(u);
      const j = await r.json().catch(() => ({}));
      const loc = j && j.results && j.results[0] && j.results[0].geometry && j.results[0].geometry.location;
      if (loc && typeof loc.lat === 'number') results.push({ id: String(it.id), lat: loc.lat, lng: loc.lng });
    } catch (_) { /* skip this address; the pin just won't show */ }
  }
  return res.status(200).json({ results });
}
