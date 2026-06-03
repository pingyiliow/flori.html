import crypto from 'crypto';

// GET /api/callback?code=xxx&shop=xxx&state=xxx&hmac=xxx&timestamp=xxx
export default async function handler(req, res) {
  const query = req.query;

  // ── 1. Verify HMAC signature from Shopify ─────────────────────
  // Build message from ALL params except hmac itself, sorted alphabetically
  const { hmac: receivedHmac, ...paramsForHmac } = query;
  const secret = process.env.SHOPIFY_CLIENT_SECRET || '';

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
        <h2>HMAC verification failed</h2>
        <p>The <strong>SHOPIFY_CLIENT_SECRET</strong> in Vercel does not match the one in your Shopify Partners app.</p>
        <p>Steps to fix:</p>
        <ol>
          <li>Go to <a href="https://partners.shopify.com">partners.shopify.com</a></li>
          <li>Click your Flori app → <strong>App credentials</strong></li>
          <li>Copy the <strong>Client secret</strong> exactly</li>
          <li>Go to Vercel → Settings → Environment Variables</li>
          <li>Update <strong>SHOPIFY_CLIENT_SECRET</strong> with the correct value</li>
          <li>Redeploy</li>
        </ol>
        <a href="/">← Go back</a>
      </body></html>
    `);
  }

  // ── 2. Verify state (CSRF protection) ─────────────────────────
  const { code, shop, state } = query;
  const cookieHeader = req.headers.cookie || '';
  const stateCookie  = cookieHeader.split(';').map(c => c.trim()).find(c => c.startsWith('flori_oauth_state='));
  const savedState   = stateCookie ? stateCookie.split('=').slice(1).join('=') : null;

  if (!savedState || state !== savedState) {
    return res.status(403).send('State mismatch. Please try connecting again from the app.');
  }

  // ── 3. Exchange code for access token ─────────────────────────
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

  // ── 4. Clear state cookie, redirect to app with token ─────────
  res.setHeader('Set-Cookie',
    'flori_oauth_state=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0'
  );

  const appUrl = process.env.APP_URL || `https://${req.headers.host}`;
  res.redirect(302, `${appUrl}/#connected?shop=${encodeURIComponent(shop)}&token=${access_token}`);
}
