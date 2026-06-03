// POST /api/connect  { shop: "bamboo-florist.myshopify.com" }
// Exchanges stored Dev Dashboard credentials for a Shopify access token
// Runs server-side on Vercel — no CORS issues

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const clientId     = process.env.SHOPIFY_CLIENT_ID     || '';
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET || '';

  if (!clientId || !clientSecret) {
    return res.status(500).json({
      error: 'Server not configured — SHOPIFY_CLIENT_ID or SHOPIFY_CLIENT_SECRET missing in Vercel environment variables.'
    });
  }

  let shop;
  try {
    const body = await req.json().catch(() => req.body);
    shop = (body?.shop || '').trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '').toLowerCase();
  } catch (_) {
    return res.status(400).json({ error: 'Invalid request body' });
  }

  if (!shop || !shop.endsWith('.myshopify.com')) {
    return res.status(400).json({ error: 'Invalid shop URL — must end with .myshopify.com' });
  }

  try {
    const tokenResp = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method:  'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept':       'application/json',
      },
      body: new URLSearchParams({
        grant_type:    'client_credentials',
        client_id:     clientId,
        client_secret: clientSecret,
      }).toString(),
    });

    const text = await tokenResp.text();
    let data;
    try { data = JSON.parse(text); } catch (_) {
      return res.status(502).json({ error: 'Shopify returned unexpected response', detail: text.slice(0, 200) });
    }

    if (data.access_token) {
      return res.status(200).json({ token: data.access_token, shop });
    }

    // Handle known Shopify errors with clear messages
    const shopifyErr = data.error || '';
    if (shopifyErr.includes('shop_not_permitted')) {
      return res.status(403).json({
        error: 'shop_not_permitted',
        message: 'This store is not in the same Shopify organisation as your Dev Dashboard app. Open Shopify Admin → click your store name (top right) → Dev Dashboard — this links them together. Then try again.'
      });
    }

    return res.status(400).json({ error: data.error_description || data.error || 'Unknown error', raw: data });

  } catch (e) {
    return res.status(502).json({ error: 'Network error reaching Shopify: ' + e.message });
  }
}
