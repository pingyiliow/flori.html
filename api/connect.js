// POST /api/connect  { shop: "bamboo-florist.myshopify.com" }
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
      error: 'Server not configured — SHOPIFY_CLIENT_ID or SHOPIFY_CLIENT_SECRET missing in Vercel.'
    });
  }

  // Vercel Node.js runtime auto-parses JSON body into req.body
  const body = req.body || {};
  const shop = String(body.shop || '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '')
    .toLowerCase();

  if (!shop || !shop.endsWith('.myshopify.com')) {
    return res.status(400).json({ error: 'Enter a valid .myshopify.com URL' });
  }

  try {
    const tokenResp = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
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
      return res.status(502).json({
        error: 'Shopify returned unexpected response',
        detail: text.slice(0, 300)
      });
    }

    if (data.access_token) {
      return res.status(200).json({ token: data.access_token, shop });
    }

    const errCode = data.error || '';
    if (errCode.includes('shop_not_permitted')) {
      return res.status(403).json({
        error: 'shop_not_permitted',
        message: 'Store is not linked to this Dev Dashboard app. Fix: open Shopify Admin → click store name (top right) → Dev Dashboard. Then try again.'
      });
    }

    return res.status(400).json({
      error: data.error_description || data.error || 'Shopify refused the request',
      raw: data
    });

  } catch (e) {
    return res.status(502).json({ error: 'Network error: ' + e.message });
  }
}
