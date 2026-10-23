// POST /api/query { query, variables?, shop?, authToken?, token? }
//
// Server-side Shopify GraphQL proxy. Staff never hold a Shopify token:
//  - If the request carries an explicit `token`, it's used as-is (legacy/admin).
//  - Otherwise the server mints a token via client_credentials (cached) and uses
//    it — but ONLY for an authenticated BloomFlow user, so this endpoint can't be
//    abused as an open public proxy to the store's data.
// The Shopify token is never sent to the browser and never stored in Supabase.

import crypto from 'crypto';

const SB_URL  = process.env.SUPABASE_URL || 'https://oyrngwazbqmxoeihyfoy.supabase.co';
const SB_ANON = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im95cm5nd2F6YnFteG9laWh5Zm95Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA3MzQ1MjksImV4cCI6MjA5NjMxMDUyOX0.SFySJvTDJCa2in9r_Rvvg5akPMEhGloCS6H08RtPOPE';

// ── Lalamove Partner API v3 (signed proxy; folded here so we don't add a 13th
// serverless function past Vercel's Hobby limit). Secret stays server-side. The client
// sends the prepared {data} payload; we HMAC-sign and forward.
// Signature string = `${time}\r\n${METHOD}\r\n${path}\r\n\r\n${body}` (hex, sha256). ──
function _lalaHeaders(method, path, bodyStr){
  const key = process.env.LALAMOVE_API_KEY, secret = process.env.LALAMOVE_API_SECRET;
  const ts = Date.now().toString();
  const raw = `${ts}\r\n${method}\r\n${path}\r\n\r\n${bodyStr || ''}`;
  const sig = crypto.createHmac('sha256', secret).update(raw).digest('hex');
  return { Authorization: `hmac ${key}:${ts}:${sig}`, Market: process.env.LALAMOVE_MARKET || 'MY', 'Content-Type': 'application/json', Accept: 'application/json' };
}
async function _lalaCall(method, endpoint, dataObj){
  const base = (process.env.LALAMOVE_HOST || 'https://rest.sandbox.lalamove.com/v3').replace(/\/+$/, '');
  const url = base + endpoint;
  const path = new URL(url).pathname;                        // e.g. /v3/quotations
  const bodyStr = dataObj ? JSON.stringify({ data: dataObj }) : '';
  const r = await fetch(url, { method, headers: _lalaHeaders(method, path, bodyStr), body: bodyStr || undefined });
  const text = await r.text(); let j; try { j = JSON.parse(text); } catch(_){ j = { raw: text.slice(0, 300) }; }
  return { status: r.status, ok: r.ok, body: j };
}
async function handleLalamove(res, L){
  const op = L && L.op;
  // Mode probe (no Lalamove call): live when a non-sandbox host is configured + keys present.
  if (op === 'mode'){
    const host = (process.env.LALAMOVE_HOST || '').toLowerCase();
    const configured = !!(process.env.LALAMOVE_API_KEY && process.env.LALAMOVE_API_SECRET);
    const live = configured && !!host && !host.includes('sandbox');
    return res.status(200).json({ mode: live ? 'live' : 'sandbox', configured });
  }
  if (!process.env.LALAMOVE_API_KEY || !process.env.LALAMOVE_API_SECRET) return res.status(501).json({ error: 'lalamove_not_configured' });
  try {
    if (op === 'cities') return res.status(200).json(await _lalaCall('GET', '/cities', null));
    if (op === 'quote')  return res.status(200).json(await _lalaCall('POST', '/quotations', L.data));
    if (op === 'place')  return res.status(200).json(await _lalaCall('POST', '/orders', L.data));
    if (op === 'get')    return res.status(200).json(await _lalaCall('GET', '/orders/' + encodeURIComponent(L.orderId), null));
    if (op === 'driver') return res.status(200).json(await _lalaCall('GET', '/orders/' + encodeURIComponent(L.orderId) + '/drivers/' + encodeURIComponent(L.driverId), null));
    if (op === 'priority') return res.status(200).json(await _lalaCall('POST', '/orders/' + encodeURIComponent(L.orderId) + '/priority-fee', L.data));
    if (op === 'changeDriver') return res.status(200).json(await _lalaCall('DELETE', '/orders/' + encodeURIComponent(L.orderId) + '/drivers/' + encodeURIComponent(L.driverId), L.data || { driverId: String(L.driverId), reason: 'DRIVER_UNRESPONSIVE' }));
    if (op === 'cancel') return res.status(200).json(await _lalaCall('DELETE', '/orders/' + encodeURIComponent(L.orderId), null));
    return res.status(400).json({ error: 'unknown_lalamove_op' });
  } catch(e){ return res.status(200).json({ error: String(e && e.message || e) }); }
}

const norm = s => String(s || '').trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '').toLowerCase();

// In-memory token cache (persists across warm invocations of the same instance).
let _tok = null, _tokShop = null, _tokExp = 0;

async function getServerToken(shop) {
  const now = Date.now();
  if (_tok && _tokShop === shop && now < _tokExp) return _tok;
  const clientId = process.env.SHOPIFY_CLIENT_ID || '';
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET || '';
  if (!clientId || !clientSecret) throw new Error('Server not configured (SHOPIFY_CLIENT_ID/SECRET)');
  const r = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }).toString(),
  });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch (_) { throw new Error('Unexpected token response: ' + text.slice(0, 120)); }
  if (!data.access_token) throw new Error(data.error_description || data.error || 'No access_token');
  _tok = data.access_token; _tokShop = shop;
  const ttlMs = data.expires_in ? data.expires_in * 1000 : 3600 * 1000;
  _tokExp = now + Math.max(60000, ttlMs - 60000); // refresh a minute early
  return _tok;
}

// Verify the caller is a logged-in Supabase user (so only staff trigger server tokens).
async function _authedUser(jwt) {
  if (!jwt) return null;
  try {
    const r = await fetch(`${SB_URL}/auth/v1/user`, { headers: { apikey: SB_ANON, Authorization: `Bearer ${jwt}` } });
    if (!r.ok) return null;
    const u = await r.json();
    return (u && u.id) ? u : null;
  } catch (_) { return null; }
}
async function isAuthedUser(jwt) { return !!(await _authedUser(jwt)); }

// ── Team management (owner-only; folded here to stay under Vercel's function cap).
// The owner adds/removes staff logins and edits any profile (incl. position/role)
// straight from the app's Team page — no Supabase dashboard needed. The service key
// stays server-side; the gate is the OWNER account's verified JWT email.
const OWNER_EMAIL = (process.env.OWNER_EMAIL || 'madeleineliow@gmail.com').toLowerCase();
async function handleTeam(res, T, jwt) {
  const SVC = process.env.SUPABASE_SERVICE_KEY;
  if (!SVC) return res.status(500).json({ error: 'SUPABASE_SERVICE_KEY missing in Vercel env' });
  const caller = await _authedUser(jwt);
  if (!caller) return res.status(401).json({ error: 'Sign in required' });
  if (String(caller.email || '').toLowerCase() !== OWNER_EMAIL) return res.status(403).json({ error: 'Owner only' });
  const H = { apikey: SVC, Authorization: `Bearer ${SVC}`, 'Content-Type': 'application/json' };
  const op = T && T.op;
  try {
    if (op === 'create') {
      const { email, password, name, role, position } = T;
      if (!email || !password || !name) return res.status(400).json({ error: 'Email, password and name are required' });
      if (String(password).length < 6) return res.status(400).json({ error: 'Password needs at least 6 characters' });
      const r = await fetch(`${SB_URL}/auth/v1/admin/users`, { method: 'POST', headers: H,
        body: JSON.stringify({ email, password, email_confirm: true }) });
      const u = await r.json().catch(() => ({}));
      if (!r.ok || !u.id) return res.status(400).json({ error: (u && (u.msg || u.message || u.error_description)) || 'Could not create the login' });
      const p = await fetch(`${SB_URL}/rest/v1/profiles?on_conflict=id`, { method: 'POST',
        headers: { ...H, Prefer: 'resolution=merge-duplicates' },
        body: JSON.stringify([{ id: u.id, name, role: role || 'florist', position: position || null }]) });
      if (!p.ok) return res.status(400).json({ error: 'Login created but profile failed: ' + (await p.text()).slice(0, 200) });
      return res.status(200).json({ ok: true, id: u.id });
    }
    if (op === 'update') {
      const { id, patch } = T;
      if (!id || !patch) return res.status(400).json({ error: 'id and patch required' });
      const allowed = {}; ['name', 'role', 'position', 'phone', 'birthday', 'bio'].forEach(k => { if (k in patch) allowed[k] = patch[k]; });
      if (!Object.keys(allowed).length) return res.status(400).json({ error: 'Nothing to update' });
      const p = await fetch(`${SB_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(id)}`, { method: 'PATCH', headers: { ...H, Prefer: 'return=representation' }, body: JSON.stringify(allowed) });
      if (!p.ok) return res.status(400).json({ error: (await p.text()).slice(0, 200) });
      return res.status(200).json({ ok: true });
    }
    if (op === 'remove') {
      const { id } = T;
      if (!id) return res.status(400).json({ error: 'id required' });
      if (id === caller.id) return res.status(400).json({ error: 'You cannot remove yourself' });
      const d = await fetch(`${SB_URL}/auth/v1/admin/users/${encodeURIComponent(id)}`, { method: 'DELETE', headers: H });
      if (!d.ok && d.status !== 404) return res.status(400).json({ error: 'Could not delete the login: ' + (await d.text()).slice(0, 200) });
      await fetch(`${SB_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE', headers: H }).catch(() => {});
      return res.status(200).json({ ok: true });
    }
    return res.status(400).json({ error: 'Unknown team op' });
  } catch (e) { return res.status(500).json({ error: e.message }); }
}

async function callShopify(shop, token, query, variables) {
  const resp = await fetch(`https://${shop}/admin/api/2025-01/graphql.json`, {
    method: 'POST',
    headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ query, variables: variables || {} }),
  });
  return { status: resp.status, text: await resp.text() };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const body = req.body || {};
  // Team management (owner-gated) — no `query`, handled first.
  if (body.team) {
    const jwt = body.authToken || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    return handleTeam(res, body.team, jwt);
  }
  // Lalamove proxy (staff-gated) — handled before the Shopify path since it carries no `query`.
  if (body.lalamove) {
    const jwt = body.authToken || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!(await isAuthedUser(jwt))) return res.status(401).json({ error: 'Sign in required' });
    return handleLalamove(res, body.lalamove);
  }
  const { query, variables } = body;
  let { shop, token, authToken } = body;
  if (!query) return res.status(400).json({ error: 'Missing: query' });

  shop = norm(shop) || norm(process.env.SHOPIFY_SHOP);
  if (!shop) return res.status(400).json({ error: 'Missing: shop' });

  let serverMinted = false;
  if (!token) {
    // No client token → server-managed token, gated on an authenticated staff session.
    const jwt = authToken || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!(await isAuthedUser(jwt))) return res.status(401).json({ error: 'Sign in required' });
    if (body.refreshToken) { _tok = null; _tokExp = 0; }   // force a fresh mint (e.g. after a scope change)
    try { token = await getServerToken(shop); serverMinted = true; }
    catch (e) { return res.status(500).json({ error: 'Could not obtain Shopify token: ' + e.message }); }
  }

  let out;
  try {
    out = await callShopify(shop, token, query, variables);
    // Refresh the server-minted token and retry once if it looks stale: either a
    // 401 (expired) OR a GraphQL "access denied / scope" error (HTTP 200) — the
    // latter happens right after the app's scopes change, while the cached token
    // still carries the old scopes. Busting the cache re-mints with the new ones.
    const scopeErr = out.status === 200 && /access denied|access scope/i.test(out.text || '');
    if (serverMinted && (out.status === 401 || scopeErr)) {
      _tok = null; _tokExp = 0;
      token = await getServerToken(shop);
      out = await callShopify(shop, token, query, variables);
    }
  } catch (e) {
    return res.status(502).json({ error: 'Cannot reach Shopify: ' + e.message });
  }

  res.setHeader('Content-Type', 'application/json');
  res.status(out.status).send(out.text);
}
