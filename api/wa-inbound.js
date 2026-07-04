// GET  /api/wa-inbound  → Meta webhook verification (hub.challenge)
// POST /api/wa-inbound  → inbound WhatsApp messages on the delivery-notice line (60174878120)
//
// The notice line is send-only and not monitored by staff. When a customer replies, auto-
// answer ONCE with a fixed bilingual message pointing them to the main line + website (a
// free-form text reply is allowed within the 24h customer-service window, since they just
// messaged). Then match the sender's phone to a CRM customer and drop a light
// "配送通知回复 + date" note — NO conversation content is stored, NO inbox is built.
// Throttled to one reply + note per sender per day.

import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

export const config = { api: { bodyParser: false } };   // raw body for Meta signature

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;
const WA_PHONE_ID  = process.env.WHATSAPP_PHONE_NUMBER_ID;
const WA_TOKEN     = process.env.WHATSAPP_ACCESS_TOKEN;
const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;   // you invent this; also set in Meta
const APP_SECRET   = process.env.WHATSAPP_APP_SECRET;     // Meta app secret (optional, for sig check)
const GRAPH_VER    = 'v21.0';

const AUTO_REPLY =
`Thank you for reaching Bamboo Green Florist🌿

This is our delivery-notice line and isn't monitored.

For orders & enquiries, message our main line 👉 60124778120
Or browse and order on our website 👉 www.bambooflorist.com.my

We'd love to arrange something for you 🌸

谢谢你联系 Bamboo Green Florist🌿

这是我们的配送通知专线，平时没有专人查看讯息哦。

订购与查询，请联系我们的主线 👉 016-477 8120（可直接 WhatsApp）
或浏览我们的网站自行选购 👉 www.bambooflorist.com.my

期待为你插上一束刚刚好的花 🌸`;

function readRaw(req) {
  return new Promise((resolve, reject) => {
    const c = []; req.on('data', x => c.push(x)); req.on('end', () => resolve(Buffer.concat(c))); req.on('error', reject);
  });
}
// Mirror flori.html/quiz.js: digits only, Malaysian +60 -> leading 0.
function normPhone(s) { let d = String(s || '').replace(/\D/g, ''); if (d.startsWith('60')) d = '0' + d.slice(2); return d; }

export default async function handler(req, res) {
  // 1) Webhook verification handshake (Meta sends a GET when you save the callback URL).
  if (req.method === 'GET') {
    const q = req.query || {};
    if (q['hub.mode'] === 'subscribe' && VERIFY_TOKEN && q['hub.verify_token'] === VERIFY_TOKEN) {
      return res.status(200).send(q['hub.challenge']);
    }
    return res.status(403).send('Forbidden');
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const raw = await readRaw(req);

  // 2) Verify Meta signature: X-Hub-Signature-256 = "sha256=" + HMAC-SHA256(app secret, raw body).
  if (APP_SECRET) {
    const sig = req.headers['x-hub-signature-256'] || '';
    const expected = 'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(raw).digest('hex');
    const a = Buffer.from(sig), b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: 'bad signature' });
  }

  let body; try { body = JSON.parse(raw.toString('utf8') || '{}'); } catch { return res.status(200).json({ ok: true }); }
  const sb = (SB_URL && SB_KEY) ? createClient(SB_URL, SB_KEY) : null;

  try {
    for (const entry of (Array.isArray(body.entry) ? body.entry : [])) {
      for (const ch of (Array.isArray(entry.changes) ? entry.changes : [])) {
        const val = ch.value || {};
        // Only real inbound customer messages. Delivery/read receipts arrive under
        // val.statuses (for messages WE sent) and are ignored — no reply loop.
        for (const m of (Array.isArray(val.messages) ? val.messages : [])) {
          const from = String(m.from || '').replace(/\D/g, '');   // E.164 without '+'
          if (!from) continue;

          // Throttle: one auto-reply + note per sender per day (also covers Meta retries).
          if (sb) {
            const day = new Date().toISOString().slice(0, 10);
            const { error: dup } = await sb.from('wa_events').insert({ event_id: `autoreply:${from}:${day}` });
            if (dup) continue;
          }

          await sendText(from, AUTO_REPLY);              // fixed reply (free-form, 24h window)
          if (sb) await noteCustomer(sb, from);          // light CRM note, no content stored
          if (sb) await sb.from('wa_notifications').insert({ phone: from, template: 'autoreply', status: 'autoreply', created_at: new Date().toISOString() }).then(() => {}, () => {});
        }
      }
    }
  } catch (err) { console.error('[wa-inbound]', err && err.message); }

  return res.status(200).json({ ok: true });   // always ack so Meta doesn't retry-storm
}

async function sendText(to, bodyText) {
  try {
    await fetch(`https://graph.facebook.com/${GRAPH_VER}/${WA_PHONE_ID}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${WA_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: bodyText, preview_url: false } }),
    });
  } catch (e) { console.error('[wa-inbound] sendText', e && e.message); }
}

// Match the sender's phone to a CRM customer and add a one-line note. No message content.
async function noteCustomer(sb, fromDigits) {
  try {
    const nsn = normPhone(fromDigits);
    if (!nsn || nsn.length < 7) return;
    const needle = nsn.replace(/^0/, '');   // substring for ilike (drops leading 0)
    const { data } = await sb.from('customers').select('id,phone').ilike('phone', `%${needle}%`).limit(50);
    const match = (data || []).find(c => normPhone(c.phone) === nsn);
    if (!match) return;
    const date = new Date().toISOString().slice(0, 10);
    await sb.from('customer_notes').insert({
      customer_id: match.id,
      note: `配送通知回复 (auto-reply sent) — ${date}`,
      author_id: null, author_name: 'WhatsApp 自动回复',
    });
  } catch (e) { console.error('[wa-inbound] noteCustomer', e && e.message); }
}
