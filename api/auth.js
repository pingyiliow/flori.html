import crypto from 'crypto';

export default function handler(req, res) {
  const { shop } = req.query;
  const raw = (shop || '').trim().replace(/^https?:\/\//i,'').replace(/\/+$/,'').toLowerCase();

  if (!raw || !raw.endsWith('.myshopify.com')) {
    return res.status(400).send('Invalid shop URL');
  }

  const clientId = process.env.SHOPIFY_CLIENT_ID;
  const appUrl   = process.env.APP_URL || `https://${req.headers.host}`;

  if (!clientId) return res.status(500).send('SHOPIFY_CLIENT_ID not set in Vercel');

  const state       = crypto.randomBytes(16).toString('hex');
  const redirectUri = `${appUrl}/api/callback`;
  const scopes      = 'read_orders,read_products,read_customers';

  res.setHeader('Set-Cookie',
    `flori_state=${state}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`
  );

  const url = `https://${raw}/admin/oauth/authorize?` + new URLSearchParams({
    client_id:    clientId,
    scope:        scopes,
    redirect_uri: redirectUri,
    state,
  });

  res.redirect(302, url);
}
