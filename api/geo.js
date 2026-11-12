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

// ── Customer order form (public, but only for the holder of a form link) ─────────────
// A New Orders entry gets a random form_token; the link /order.html?t=<token> lets the
// customer read and fill in THAT entry only. Server-side with the service key; the anon
// key never sees followups. Open for 7 days from sending; read-only once the entry is in
// Shopify; gone once it is completed.
const SB_SVC = process.env.SUPABASE_SERVICE_KEY;
const FORM_DAYS = 7;
// Delivery fee: Shopify's own Local Delivery zones (the fee checkout charges), asked through
// draftOrderAvailableDeliveryOptions. Zones go by postcode; Shopify also needs the state,
// which a Malaysian postcode gives.
const SHOP = (s => { s = String(s || '').trim().toLowerCase().replace(/^https?:\/\//, ''); if (s && !s.includes('.')) s += '.myshopify.com'; return s; })(process.env.SHOPIFY_SHOP);
let _stok = null, _stokExp = 0;
async function shopToken() {
  if (_stok && Date.now() < _stokExp) return _stok;
  const id = process.env.SHOPIFY_CLIENT_ID, secret = process.env.SHOPIFY_CLIENT_SECRET;
  if (!SHOP || !id || !secret) throw new Error('shopify_not_configured');
  const r = await fetch('https://' + SHOP + '/admin/oauth/access_token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret }).toString() });
  const j = await r.json().catch(() => ({}));
  if (!j.access_token) throw new Error('no_token');
  _stok = j.access_token; _stokExp = Date.now() + Math.max(60000, (j.expires_in ? j.expires_in * 1000 : 3600000) - 60000);
  return _stok;
}
const MY_PC = [[1000,2999,'PLS'],[5000,9999,'KDH'],[10000,14999,'PNG'],[15000,18999,'KTN'],[20000,24999,'TRG'],[25000,28999,'PHG'],[30000,36999,'PRK'],[39000,39999,'PHG'],[40000,48999,'SGR'],[49000,49999,'PHG'],[50000,60999,'KUL'],[62000,62999,'PJY'],[63000,68999,'SGR'],[70000,73999,'NSN'],[75000,78999,'MLK'],[79000,86999,'JHR'],[87000,87999,'LBN'],[88000,91999,'SBH'],[93000,98999,'SWK']];
const myState = pc => { const n = parseInt(pc, 10); const r = MY_PC.find(x => n >= x[0] && n <= x[1]); return r ? r[2] : null; };
// The form works the fee out only when staff gave neither an address nor a fee (a fee or
// address from staff, free delivery included, stays as it is). Once worked out, fee_auto
// keeps it following the customer's address.
function feeAuto(row) {
  if (row.fee_auto === true) return true;
  if (row.fee_auto === false) return false;
  return !(Number(row.delivery_fee) > 0) && !String(row.addr || '').trim();
}
async function shopFee(row, addr) {
  const pcs = String(addr || '').match(/\b\d{5}\b/g), pc = pcs && pcs[pcs.length - 1];
  if (!pc) return { need: 'postcode' };
  const st = myState(pc); if (!st) return { out: true };
  const items = (Array.isArray(row.item_list) ? row.item_list : []).map(it => ({ title: _s(it && it.name, 200) || 'Item',
    originalUnitPriceWithCurrency: { amount: (Number(it && it.price) || 0).toFixed(2), currencyCode: 'MYR' }, quantity: parseInt(it && it.qty, 10) || 1, requiresShipping: true }));
  if (!items.length) items.push({ title: 'Flowers', originalUnitPriceWithCurrency: { amount: (Number(row.amount) || 100).toFixed(2), currencyCode: 'MYR' }, quantity: 1, requiresShipping: true });
  try {
    const tok = await shopToken();
    const r = await fetch('https://' + SHOP + '/admin/api/2026-04/graphql.json', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': tok },
      body: JSON.stringify({ query: 'query($i: DraftOrderAvailableDeliveryOptionsInput!){ draftOrderAvailableDeliveryOptions(input:$i){ availableLocalDeliveryRates { price { amount } } } }',
        variables: { i: { lineItems: items, shippingAddress: { address1: _s(String(addr).split('\n')[0], 200) || 'Address', zip: pc, provinceCode: st, countryCode: 'MY' } } } }) });
    const j = await r.json().catch(() => null);
    const o = j && j.data && j.data.draftOrderAvailableDeliveryOptions, rates = o && o.availableLocalDeliveryRates;
    if (!Array.isArray(rates)) return { error: true };
    if (!rates.length) return { out: true };
    return { fee: Math.min(...rates.map(x => Number(x.price && x.price.amount) || 0)) };
  } catch (_) { return { error: true }; }
}
async function svc(path, opts) {
  opts = opts || {};
  const r = await fetch(SB_URL + '/rest/v1/' + path, { ...opts, headers: { apikey: SB_SVC, Authorization: 'Bearer ' + SB_SVC, 'Content-Type': 'application/json', Prefer: 'return=representation', ...(opts.headers || {}) } });
  const j = await r.json().catch(() => null);
  return { ok: r.ok, status: r.status, j };
}
async function formRow(t) {
  t = String(t || '');
  if (!SB_SVC || !/^[a-f0-9]{32,64}$/.test(t)) return null;
  const { ok, j } = await svc('followups?form_token=eq.' + t + '&select=*');
  return (ok && Array.isArray(j) && j[0]) || null;
}
function formState(row) {
  if (!row) return 'expired';
  // In Shopify (draft or order) or completed: the customer can still look it up, read-only.
  if (row.status === 'completed' || row.status === 'draft' || row.shopify_draft_id || row.order_no) return 'locked';
  const sent = row.form_sent_at ? Date.parse(row.form_sent_at) : 0;
  if (sent && Date.now() - sent > FORM_DAYS * 864e5) return 'expired';
  return 'open';
}
const _s = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
function formPublic(row) {
  const list = Array.isArray(row.item_list) ? row.item_list : [];
  const items = list.map(it => ({
    name: _s(it && it.name, 200), images: (Array.isArray(it && it.images) ? it.images : []).filter(u => /^https:\/\//.test(String(u))).slice(0, 10),
    price: (it && it.price != null && it.price !== '') ? Number(it.price) : null, qty: parseInt(it && it.qty, 10) || 1,
    // Flower instructions, so the customer can check them (one item: the order's own note).
    note: _s((it && it.flowerNote) || (list.length === 1 ? row.flower_note : ''), 500),
  }));
  return {
    ref: 'NO-' + String(row.id || '').replace(/\D/g, '').slice(-5),
    state: formState(row), submitted: row.form_status === 'submitted',
    name: row.name || '', contact: row.contact || '', email: row.email || '',
    recipName: row.recip_name || '', recipPhone: row.recip_phone || '', recipCompany: row.recip_company || '', noCard: !!row.no_card,
    fulfil: row.fulfil || 'delivery', dueDate: row.due_date || '', dueTime: row.due_time || '',
    addr: row.addr || '', deliveryInstr: row.delivery_instr || '', cardMsg: row.card_msg || '', custNote: row.cust_note || '',
    items, amount: Number(row.amount) || 0, deliveryFee: Number(row.delivery_fee) || 0,
    paid: row.payment === 'paid', slip: !!row.pay_slip, orderNo: row.order_no || '', feeAuto: feeAuto(row),
  };
}
// Tell the staff app something changed (same broadcast channel the app uses).
async function pingStaff() {
  try {
    await fetch(SB_URL + '/realtime/v1/api/broadcast', { method: 'POST', headers: { apikey: SB_SVC, Authorization: 'Bearer ' + SB_SVC, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ topic: 'bf-live', event: 'chg', payload: { t: 'followups' } }] }) });
  } catch (_) {}
}
async function formHandler(body, res) {
  if (!SB_SVC) return res.status(501).json({ error: 'form_not_configured' });
  const row = await formRow(body.t);
  if (!row) return res.status(404).json({ error: 'not_found' });
  const st = formState(row);
  if (body.mode === 'form-get') return res.status(200).json(formPublic(row));
  if (st !== 'open') return res.status(409).json({ error: st });
  if (body.mode === 'form-fee') {
    if (!feeAuto(row)) return res.status(200).json({ fixed: true, fee: Number(row.delivery_fee) || 0 });
    return res.status(200).json(await shopFee(row, _s(body.addr, 500)));
  }
  if (body.mode === 'form-save') {
    const f = body.fields || {};
    // Paid: delivery or pickup and the fee stay as paid; the rest can still change.
    const paid = row.payment === 'paid';
    const fulfil = paid ? (row.fulfil === 'pickup' ? 'pickup' : 'delivery') : (f.fulfil === 'pickup' ? 'pickup' : 'delivery');
    const due = /^\d{4}-\d{2}-\d{2}$/.test(String(f.dueDate || '')) ? f.dueDate : null;
    const patch = {
      name: _s(f.name, 120) || row.name, contact: _s(f.contact, 40), email: _s(f.email, 160),
      recip_name: _s(f.recipName, 160), recip_phone: _s(f.recipPhone, 40), fulfil,
      recip_company: fulfil === 'pickup' ? (row.recip_company || null) : _s(f.recipCompany, 160),
      due_date: due, due_time: _s(f.dueTime, 80),
      addr: fulfil === 'pickup' ? (row.addr || null) : _s(f.addr, 500),
      delivery_instr: fulfil === 'pickup' ? (row.delivery_instr || null) : _s(f.deliveryInstr, 500),
      card_msg: f.noCard ? '' : _s(f.cardMsg, 1000), no_card: !!f.noCard, cust_note: _s(f.custNote, 1000),
      form_status: 'submitted', form_submitted_at: new Date().toISOString(),
    };
    // The form's required details (the page checks them too).
    if (!patch.name || !patch.contact || !patch.due_date || !patch.due_time || (!patch.no_card && !patch.card_msg)
        || (fulfil === 'delivery' && (!patch.recip_name || !patch.addr))) return res.status(422).json({ error: 'missing' });
    // One item: its own card message follows the order's, so the Shopify draft gets it.
    if (Array.isArray(row.item_list) && row.item_list.length === 1) patch.item_list = [{ ...row.item_list[0], cardMsg: patch.card_msg }];
    if (!paid && feeAuto(row)) {
      patch.fee_auto = true;
      if (fulfil === 'pickup') patch.delivery_fee = 0;
      else {
        const q = await shopFee(row, patch.addr);
        if (q.need) return res.status(422).json({ error: 'need_postcode' });
        // Outside the Local Delivery zones (outstation, e.g. KL) or no answer: staff set the
        // fee by hand; changing it in the app ends fee_auto.
        patch.delivery_fee = q.fee != null ? q.fee : 0;
      }
    }
    const { ok } = await svc('followups?id=eq.' + encodeURIComponent(row.id), { method: 'PATCH', body: JSON.stringify(patch) });
    if (!ok) return res.status(500).json({ error: 'save_failed' });
    await pingStaff();
    return res.status(200).json(formPublic({ ...row, ...patch }));
  }
  if (body.mode === 'form-slip') {
    const url = String(body.url || '');
    const base = String(process.env.R2_PUBLIC_URL || '').replace(/\/$/, '');
    if (!base || url.indexOf(base + '/') !== 0) return res.status(400).json({ error: 'bad_url' });
    // A receipt also counts as the customer's go-ahead (complete orders skip Confirm order).
    const { ok } = await svc('followups?id=eq.' + encodeURIComponent(row.id), { method: 'PATCH', body: JSON.stringify({ pay_slip: url, form_status: 'submitted', form_submitted_at: row.form_submitted_at || new Date().toISOString() }) });
    if (!ok) return res.status(500).json({ error: 'save_failed' });
    await pingStaff();
    return res.status(200).json({ ok: true });
  }
  return res.status(400).json({ error: 'unknown_form_mode' });
}

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
  let body = {};
  try { body = typeof req.body === 'object' && req.body ? req.body : JSON.parse(req.body || '{}'); } catch {}
  // Customer order form: its own data, no Google key needed.
  if (body.mode === 'form-get' || body.mode === 'form-save' || body.mode === 'form-slip' || body.mode === 'form-fee') return formHandler(body, res);

  const KEY = process.env.GOOGLE_MAPS_API_KEY;
  if (!KEY) return res.status(501).json({ error: 'geo_not_configured' });
  // Address search from the customer form: a link that is still open stands in for staff
  // sign-in, for suggestions and place details only.
  let viaForm = false;
  if (body.mode === 'form-addr') {
    const row = await formRow(body.t);
    if (!row || formState(row) !== 'open') return res.status(401).json({ error: 'Not authenticated' });
    body.mode = body.sub === 'place' ? 'place' : 'autocomplete';
    viaForm = true;
  }
  const jwt = body.authToken || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!viaForm && !(await verifyStaff(jwt))) return res.status(401).json({ error: 'Not authenticated' });

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

  // ── Places autocomplete (Places API New): type-ahead address suggestions ──
  // body { mode:'autocomplete', input, sessionToken? } → { predictions:[{description, placeId}] }
  if (body.mode === 'autocomplete') {
    const input = String(body.input || '').trim();
    if (input.length < 3) return res.status(200).json({ predictions: [] });
    try {
      const r = await fetch('https://places.googleapis.com/v1/places:autocomplete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': KEY },
        body: JSON.stringify({ input, includedRegionCodes: ['my'], languageCode: 'en', sessionToken: body.sessionToken || undefined }),
      });
      const j = await r.json().catch(() => ({}));
      let predictions = r.ok ? (j.suggestions || []).map(s => s.placePrediction).filter(Boolean).slice(0, 6)
        .map(p => ({ description: (p.text && p.text.text) || (p.structuredFormat && p.structuredFormat.mainText && p.structuredFormat.mainText.text) || '', placeId: p.placeId })) : [];
      // Google denied or returned nothing → free OpenStreetMap suggestions (carry coords so the
      // client doesn't need a Place Details call).
      if (!predictions.length) {
        const nom = await _nominatimSearch(input, 6);
        if (nom.length) predictions = nom.map(n => ({ description: n.description, lat: n.lat, lng: n.lng }));
      }
      return res.status(200).json({ predictions });
    } catch (e) {
      const nom = await _nominatimSearch(String(body.input || '').trim(), 6);
      return res.status(200).json({ predictions: nom.map(n => ({ description: n.description, lat: n.lat, lng: n.lng })), error: nom.length ? undefined : String(e && e.message || e) });
    }
  }
  // ── Place details (Places API New): chosen suggestion → coordinates + a clean address ──
  // body { mode:'place', placeId, sessionToken? } → { lat, lng, address }
  if (body.mode === 'place') {
    const pid = String(body.placeId || '').trim().replace(/^places\//, '');
    if (!pid) return res.status(400).json({ error: 'placeId required' });
    try {
      const u = 'https://places.googleapis.com/v1/places/' + encodeURIComponent(pid) + '?languageCode=en'
        + (body.sessionToken ? '&sessionToken=' + encodeURIComponent(String(body.sessionToken)) : '');
      const r = await fetch(u, { headers: { 'X-Goog-Api-Key': KEY, 'X-Goog-FieldMask': 'location,formattedAddress,addressComponents' } });
      const j = await r.json().catch(() => ({}));
      const loc = j && j.location;
      if (!loc || typeof loc.latitude !== 'number') return res.status(200).json({ error: (j.error && j.error.message) || 'no_geometry' });
      // Address split into the customer-profile fields (line 1/2, city, state, postcode, country).
      const comp = t => { const c = (j.addressComponents || []).find(x => (x.types || []).includes(t)); return c ? (c.longText || c.shortText || '') : ''; };
      const street = [comp('street_number'), comp('route')].filter(Boolean).join(' ');
      const line1 = [comp('subpremise'), comp('premise'), street].filter(Boolean).join(', ')
        || String(j.formattedAddress || '').split(',')[0].trim();
      const parts = {
        address1: line1,
        address2: comp('sublocality_level_1') || comp('sublocality') || comp('neighborhood'),
        city: comp('locality') || comp('administrative_area_level_2'),
        state: comp('administrative_area_level_1'),
        zip: comp('postal_code'),
        country: comp('country'),
      };
      return res.status(200).json({ lat: loc.latitude, lng: loc.longitude, address: (j.formattedAddress || null), parts });
    } catch (e) { return res.status(200).json({ error: String(e && e.message || e) }); }
  }

  const items = (Array.isArray(body.items) ? body.items : []).slice(0, 30)
    .filter(x => x && x.id != null && typeof x.address === 'string' && x.address.trim());
  if (!items.length) return res.status(400).json({ error: 'items required' });

  const results = [];
  const dbg = {};   // capture Google's own status/reason when nothing resolves (debug)
  for (const it of items) {
    try {
      const g = await geocodeAddress(it.address, KEY, dbg);
      if (g) results.push({ id: String(it.id), lat: g.lat, lng: g.lng });
    } catch (_) { /* skip this address; the pin just won't show */ }
  }
  return res.status(200).json({ results, debug: dbg.status ? dbg : undefined });
}

async function _geo1(addr, KEY, dbg) {
  const u = 'https://maps.googleapis.com/maps/api/geocode/json?address='
    + encodeURIComponent(addr) + '&region=my&components=country:MY&key=' + KEY;
  const r = await fetch(u); const j = await r.json().catch(() => ({}));
  // Surface REQUEST_DENIED (API/key), OVER_QUERY_LIMIT (billing/quota), ZERO_RESULTS (address) etc.
  if (dbg && j && j.status && j.status !== 'OK' && !dbg.status) { dbg.status = j.status; dbg.message = j.error_message || ''; }
  const loc = j && j.results && j.results[0] && j.results[0].geometry && j.results[0].geometry.location;
  return (loc && typeof loc.lat === 'number') ? { lat: loc.lat, lng: loc.lng } : null;
}
// Free OpenStreetMap (Nominatim) geocoder — used as a fallback when Google is unavailable
// (key/billing/permission issues). Low volume only; needs a User-Agent per their policy.
async function _nominatim(q) {
  try {
    const u = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=my&q=' + encodeURIComponent(q);
    const r = await fetch(u, { headers: { 'User-Agent': 'BloomFlow/1.0 (florist delivery app)' } });
    const j = await r.json().catch(() => []);
    if (Array.isArray(j) && j[0] && j[0].lat) return { lat: parseFloat(j[0].lat), lng: parseFloat(j[0].lon) };
  } catch (_) {}
  return null;
}
async function _nominatimSearch(q, limit) {
  try {
    const u = 'https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=0&limit=' + (limit || 6) + '&countrycodes=my&q=' + encodeURIComponent(q);
    const r = await fetch(u, { headers: { 'User-Agent': 'BloomFlow/1.0 (florist delivery app)' } });
    const j = await r.json().catch(() => []);
    if (!Array.isArray(j)) return [];
    return j.filter(x => x && x.lat).map(x => ({ description: x.display_name, lat: parseFloat(x.lat), lng: parseFloat(x.lon) }));
  } catch (_) { return []; }
}
// Try the full address; if Google can't match it, retry with cleaner variants: drop a leading
// business-name segment (everything before the first part that has a digit — usually the street
// number), then fall back to postcode + town. If Google is denied/unavailable entirely, fall
// back to free OpenStreetMap so addresses still resolve.
async function geocodeAddress(address, KEY, dbg) {
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
    try { const g = await _geo1(t, KEY, dbg); if (g) return g; } catch (_) {}
  }
  for (const t of tries) { const g = await _nominatim(t); if (g) return g; }   // OSM fallback
  return null;
}
