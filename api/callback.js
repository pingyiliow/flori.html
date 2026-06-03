import crypto from 'crypto';

// GET /api/callback?code=xxx&shop=xxx&state=xxx&hmac=xxx
export default async function handler(req, res) {
  const { code, shop, state, hmac, timestamp, ...rest } = req.query;

  // ── 1. Verify state (CSRF protection) ─────────────────────────
  const cookieHeader  = req.headers.cookie || '';
  const stateCookie   = cookieHeader.split(';').map(c => c.trim()).find(c => c.startsWith('flori_oauth_state='));
  const savedState    = stateCookie ? stateCookie.split('=').slice(1).join('=') : null;

  if (!savedState || state !== savedState) {
    return res.status(403).send('State mismatch — possible CSRF attempt. Please try connecting again.');
  }

  // ── 2. Verify HMAC signature from Shopify ─────────────────────
  const secret   = process.env.SHOPIFY_CLIENT_SECRET;
  const toVerify = Object.entries({ ...rest, shop, state, timestamp })
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const digest   = crypto.createHmac('sha256', secret).update(toVerify).digest('hex');

  if (!crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmac || ''))) {
    return res.status(403).send('HMAC verification failed — the request may have been tampered with.');
  }

  // ── 3. Exchange code for access token ────────────────────────
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
      return res.status(400).send(`Shopify did not return a token: ${err}`);
    }
  } catch (e) {
    return res.status(502).send('Could not reach Shopify: ' + e.message);
  }

  // ── 4. Clear state cookie, redirect to app with token ─────────
  res.setHeader('Set-Cookie',
    'flori_oauth_state=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0'
  );

  // Token is passed in URL hash — never sent to server, extracted by JS
  const appUrl = process.env.APP_URL || `https://${req.headers.host}`;
  res.redirect(302, `${appUrl}/#connected?shop=${encodeURIComponent(shop)}&token=${access_token}`);
}
