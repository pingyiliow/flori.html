import crypto from 'crypto';

// GET /api/auth?shop=bamboo-florist.myshopify.com
export default function handler(req, res) {
  const { shop } = req.query;

  if (!shop || !shop.match(/^[a-zA-Z0-9-]+\.myshopify\.com$/)) {
    return res.status(400).send(`
      <html><body style="font-family:sans-serif;padding:40px">
        <h2>Invalid store URL</h2>
        <p>Expected format: <code>your-store.myshopify.com</code></p>
        <a href="/">← Go back</a>
      </body></html>
    `);
  }

  const clientId = process.env.SHOPIFY_CLIENT_ID;
  const appUrl   = process.env.APP_URL || `https://${req.headers.host}`;

  if (!clientId) {
    return res.status(500).send('SHOPIFY_CLIENT_ID environment variable not set');
  }

  const state       = crypto.randomBytes(16).toString('hex');
  const redirectUri = `${appUrl}/api/callback`;
  const scopes      = 'read_orders,read_products,read_customers';

  // Save state in cookie (10 min) for CSRF verification
  res.setHeader('Set-Cookie',
    `flori_oauth_state=${state}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`
  );

  const authUrl = `https://${shop}/admin/oauth/authorize?` + new URLSearchParams({
    client_id:        clientId,
    scope:            scopes,
    redirect_uri:     redirectUri,
    state:            state,
    'grant_options[]': '',
  });

  res.redirect(302, authUrl);
}
