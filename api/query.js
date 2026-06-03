// POST /api/query { shop, token, query }
// Server-side proxy for Shopify GraphQL — solves CORS for browser clients
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { shop, token, query, variables } = req.body || {};
  if (!shop || !token || !query) {
    return res.status(400).json({ error: 'Missing shop, token, or query' });
  }

  try {
    const r = await fetch(`https://${shop}/admin/api/2025-01/graphql.json`, {
      method: 'POST',
      headers: {
        'X-Shopify-Access-Token': token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query, variables }),
    });

    const text = await r.text();
    let data;
    try { data = JSON.parse(text); } catch (_) {
      return res.status(502).json({ error: 'Shopify returned non-JSON', detail: text.slice(0, 300) });
    }

    return res.status(r.status).json(data);
  } catch (e) {
    return res.status(502).json({ error: 'Could not reach Shopify: ' + e.message });
  }
}
