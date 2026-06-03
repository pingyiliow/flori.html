// POST /api/query { shop, token, query, variables? }
// Server-side proxy — avoids CORS, returns Shopify response verbatim
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'POST only' });

  const body = req.body || {};
  const { shop, token, query, variables } = body;

  if (!shop)  return res.status(400).json({ error: 'Missing: shop' });
  if (!token) return res.status(400).json({ error: 'Missing: token' });
  if (!query) return res.status(400).json({ error: 'Missing: query' });

  let shopifyResp, text;
  try {
    shopifyResp = await fetch(`https://${shop}/admin/api/2025-01/graphql.json`, {
      method: 'POST',
      headers: {
        'X-Shopify-Access-Token': token,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({ query, variables: variables || {} }),
    });
    text = await shopifyResp.text();
  } catch (e) {
    return res.status(502).json({ error: 'Cannot reach Shopify: ' + e.message });
  }

  // Forward Shopify's exact status + body back to Flori
  res.setHeader('Content-Type', 'application/json');
  res.status(shopifyResp.status).send(text);
}
