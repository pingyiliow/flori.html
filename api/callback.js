import crypto from 'crypto';

export default async function handler(req, res) {
  const query  = req.query;
  const secret = process.env.SHOPIFY_CLIENT_SECRET || '';

  // ── 1. Verify HMAC (confirms request is genuinely from Shopify) ──
  const { hmac: receivedHmac, ...paramsForHmac } = query;

  const message = Object.keys(paramsForHmac)
    .sort()
    .map(k => `${k}=${paramsForHmac[k]}`)
    .join('&');

  const computedHmac = crypto
    .createHmac('sha256', secret)
    .update(message)
    .digest('hex');

  if (computedHmac !== receivedHmac) {
    return res.status(403).send(`
      <html><body style="font-family:sans-serif;padding:40px;max-width:500px">
        <h2>Connection failed: HMAC mismatch</h2>
        <p>The <strong>SHOPIFY_CLIENT_SECRET</strong> in Vercel does not match your Shopify Partners app.</p>
        <ol>
          <li>Go to <a href="https://partners.shopify.com">partners.shopify.com</a> → your Flori app</li>
          <li>Copy the <strong>Client secret</strong> exactly (click Reveal)</li>
          <li>Go to Vercel → Settings → Environment Variables</li>
          <li>Update <strong>SHOPIFY_CLIENT_SECRET</strong></li>
          <li>Redeploy, then try again</li>
        </ol>
        <a href="/">← Go back</a>
      </body></html>
    `);
  }

  // ── 2. Exchange code for access token ───────────────────────────
  const { code, shop } = query;

  let access_token;
  try {
    const tokenResp = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id:     process.env.SHOPIFY_CLIENT_ID,
        client_secret: secret,
        code,
      }),
    });

    const data = await tokenResp.json();
    access_token = data.access_token;

    if (!access_token) {
      const err = data.error_description || data.error || JSON.stringify(data);
      return res.status(400).send('Shopify did not return a token: ' + err);
    }
  } catch (e) {
    return res.status(502).send('Could not reach Shopify: ' + e.message);
  }

  // ── 3. Redirect back to app with token in URL hash ──────────────
  const appUrl = process.env.APP_URL || `https://${req.headers.host}`;
  res.redirect(302,
    `${appUrl}/#connected?shop=${encodeURIComponent(shop)}&token=${access_token}`
  );
}
