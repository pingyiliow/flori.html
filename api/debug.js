// GET /api/debug — shows what env vars are set (safe, no secrets revealed)
export default function handler(req, res) {
  const cid = process.env.SHOPIFY_CLIENT_ID || '';
  const sec = process.env.SHOPIFY_CLIENT_SECRET || '';
  const url = process.env.APP_URL || '';

  res.json({
    SHOPIFY_CLIENT_ID:     cid ? `${cid.slice(0,6)}...${cid.slice(-4)} (${cid.length} chars)` : '❌ NOT SET',
    SHOPIFY_CLIENT_SECRET: sec ? `set (${sec.length} chars)` : '❌ NOT SET',
    APP_URL:               url || '❌ NOT SET',
    expected_client_id:    '1b2b76...c106 (32 chars)',
    redirect_uri_used:     `${url || 'APP_URL_MISSING'}/api/callback`,
  });
}
