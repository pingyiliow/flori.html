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
  // write_draft_orders is required by createShopifyDraft (Follow-up → Shopify Draft).
  // NOTE: the server token used by /api/query is minted via client-credentials, so
  // its scopes come from the app's configuration in the Shopify dashboard — this
  // list only applies to the OAuth authorize flow. Keep them in sync.
  const scopes      = 'read_orders,read_products,read_customers,write_draft_orders';

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
