// POST /api/query { query, variables?, shop?, authToken?, token? }
//
// Server-side Shopify GraphQL proxy. Staff never hold a Shopify token:
//  - If the request carries an explicit `token`, it's used as-is (legacy/admin).
//  - Otherwise the server mints a token via client_credentials (cached) and uses
//    it — but ONLY for an authenticated BloomFlow user, so this endpoint can't be
//    abused as an open public proxy to the store's data.
// The Shopify token is never sent to the browser and never stored in Supabase.

const SB_URL  = process.env.SUPABASE_URL || 'https://oyrngwazbqmxoeihyfoy.supabase.co';
const SB_ANON = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im95cm5nd2F6YnFteG9laWh5Zm95Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA3MzQ1MjksImV4cCI6MjA5NjMxMDUyOX0.SFySJvTDJCa2in9r_Rvvg5akPMEhGloCS6H08RtPOPE';

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
async function isAuthedUser(jwt) {
  if (!jwt) return false;
  try {
    const r = await fetch(`${SB_URL}/auth/v1/user`, { headers: { apikey: SB_ANON, Authorization: `Bearer ${jwt}` } });
    if (!r.ok) return false;
    const u = await r.json();
    return !!(u && u.id);
  } catch (_) { return false; }
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
    try { token = await getServerToken(shop); serverMinted = true; }
    catch (e) { return res.status(500).json({ error: 'Could not obtain Shopify token: ' + e.message }); }
  }

  let out;
  try {
    out = await callShopify(shop, token, query, variables);
    // If a server-minted token expired, refresh once and retry.
    if (out.status === 401 && serverMinted) {
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
