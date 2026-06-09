// POST /api/upload  { data: "data:image/jpeg;base64,…" }
// Stores the image in Cloudflare R2 and returns its public URL.
//
// Required Vercel env vars (Settings → Environment Variables):
//   R2_ACCOUNT_ID          Cloudflare account id (R2 → "Account ID")
//   R2_ACCESS_KEY_ID       R2 API token Access Key ID
//   R2_SECRET_ACCESS_KEY   R2 API token Secret Access Key
//   R2_BUCKET              bucket name, e.g. bamboo-flowers
//   R2_PUBLIC_URL          public base url, e.g. https://pub-xxxx.r2.dev
//                          (enable the bucket's r2.dev public URL or a custom domain)
//
// Until those are set the endpoint returns 501, and the app silently falls back
// to storing photos inline as base64 (current behaviour) — nothing breaks.

import { AwsClient } from 'aws4fetch';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const {
    R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, R2_PUBLIC_URL,
  } = process.env;

  // Health check (GET): reports whether the R2 env vars are present, never their
  // values. Lets you confirm config from a browser without uploading anything.
  if (req.method === 'GET') {
    return res.status(200).json({
      ok: true,
      configured: !!(R2_ACCOUNT_ID && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY && R2_BUCKET && R2_PUBLIC_URL),
      present: {
        R2_ACCOUNT_ID: !!R2_ACCOUNT_ID, R2_ACCESS_KEY_ID: !!R2_ACCESS_KEY_ID,
        R2_SECRET_ACCESS_KEY: !!R2_SECRET_ACCESS_KEY, R2_BUCKET: !!R2_BUCKET, R2_PUBLIC_URL: !!R2_PUBLIC_URL,
      },
    });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET || !R2_PUBLIC_URL) {
    // 501 = not configured. The client treats this as "use base64 fallback".
    return res.status(501).json({ error: 'R2 not configured' });
  }

  const data = (req.body && req.body.data) || '';
  const m = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(data);
  if (!m) return res.status(400).json({ error: 'Expected a base64 image data URL in "data"' });

  const contentType = m[1];
  const bytes = Buffer.from(m[2], 'base64');
  if (bytes.length > 8 * 1024 * 1024) return res.status(413).json({ error: 'Image too large' });

  const ext = (contentType.split('/')[1] || 'jpg').replace('jpeg', 'jpg').replace(/[^a-z0-9]/gi, '');
  const rand = Math.random().toString(36).slice(2, 10);
  const key = `orders/${Date.now()}-${rand}.${ext}`;

  try {
    const client = new AwsClient({
      accessKeyId: R2_ACCESS_KEY_ID,
      secretAccessKey: R2_SECRET_ACCESS_KEY,
      service: 's3',
      region: 'auto',
    });
    const endpoint = `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${R2_BUCKET}/${key}`;
    const r2 = await client.fetch(endpoint, {
      method: 'PUT',
      body: bytes,
      headers: { 'Content-Type': contentType, 'Content-Length': String(bytes.length) },
    });
    if (!r2.ok) {
      const t = await r2.text().catch(() => '');
      return res.status(502).json({ error: `R2 upload failed (${r2.status}): ${t.slice(0, 150)}` });
    }
  } catch (e) {
    return res.status(502).json({ error: 'R2 upload error: ' + (e.message || String(e)) });
  }

  const base = String(R2_PUBLIC_URL).replace(/\/+$/, '');
  return res.status(200).json({ url: `${base}/${key}` });
}
