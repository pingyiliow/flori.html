// POST /api/notify
// BloomFlow WhatsApp delivery-notification module.
// Receives EasyRoutes stop webhooks (out_for_delivery / delivered), reads the Shopify
// order, and sends a WhatsApp *Utility* template via the Meta Cloud API (direct — no BSP)
// from the dedicated sender 60174878120. See BLOOMFLOW_WHATSAPP_NOTIFY_HANDOFF.md.
//
// PRIVACY — HARD RULE: messages go ONLY to order.customer.phone (the buyer's OWN phone).
// This module NEVER reads billing_address / shipping_address / destination phone. For a
// gift order the address phone is the recipient's; sending buyer/order details there is a
// serious leak, so it must be impossible by design. Empty customer.phone -> no send, the
// order is flagged for CS instead.
//
// Scope (per handoff decisions): EasyRoutes-driven notifications only —
//   out_for_delivery -> out_for_delivery      (body {{1}} name, {{2}} order no; static phone button)
//   delivered + photo -> delivered_with_photo  (image header + body {{1}} order; url button -> order status)
//   delivered, no photo -> delivered_nophoto   (text header {{1}} order, empty body; url button -> order status)
// All positional variables, language en. Template names/shapes match WhatsApp Manager
// exactly (see the TEMPLATES map below).
// order_confirmed_bg is intentionally deferred. Sending is inline (no queue). The main
// line 60124778120 is untouched.
//
// EMAIL CHANNEL: the same delivery update is ALSO sent as a theme-matched HTML email via Resend
// (_emailTemplates.js buildOrderEmail + sendEmailViaResend) — WhatsApp and email are INDEPENDENT
// channels, so a buyer who gave both
// a phone and an email receives BOTH; a buyer with only one gets that one. Buyer email only
// (order.email/customer.email, never the shipping/billing recipient). De-dupe is per (order,
// stage, channel), so each channel fires at most once per stage. Env: RESEND_API_KEY,
// NOTIFY_EMAIL_FROM (e.g. 'Bamboo Green Florist <noreply@bambooflorist.com.my>'),
// NOTIFY_EMAIL_REPLYTO (e.g. sales@bambooflorist.com.my). Without RESEND_API_KEY/FROM the
// email branch is a no-op (logged) — WhatsApp is unaffected.
//
// GO-LIVE GATES (env): NOTIFY_ENABLED must be truthy to actually send — otherwise every
// event is processed + logged (status 'dryrun') but NOTHING is sent, so the webhook can be
// wired/verified safely. NOTIFY_PHOTO_ENABLED separately holds WhatsApp photo messages: while
// off, deliveries use the text-only template even when a proof photo exists (the email still
// shows the photo). Email test knobs: NOTIFY_FORCE_EMAIL (skip WhatsApp, exercise the email
// path for the listed order nos or all if truthy) + NOTIFY_TEST_EMAIL (redirect fallback
// emails to a test address).

import { createClient } from '@supabase/supabase-js';
import { AwsClient } from 'aws4fetch';
import crypto from 'crypto';
import { buildOrderEmail } from './_emailTemplates.js';

// EasyRoutes signs the raw request body, so we must read the bytes ourselves.
export const config = { api: { bodyParser: false } };

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;

const WA_PHONE_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;  // sender 60174878120's id
const WA_TOKEN    = process.env.WHATSAPP_ACCESS_TOKEN;     // permanent token
const ER_SECRET   = process.env.EASYROUTES_WEBHOOK_SECRET; // webhook HMAC secret
const GRAPH_VER   = 'v21.0';

/* ─── pure helpers (unit-tested in the preview before shipping) ───────────── */

// customer.phone -> E.164 WITHOUT '+', Malaysia-aware. '+60 12-345 6789', '012-345 6789'
// and '60123456789' all normalize to '60123456789'. Mirrors flori.html/quiz.js normPhone
// (digits only, local leading 0), then country-codes it for the Meta `to` field.
export function toE164MY(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (!d) return '';
  if (d.startsWith('60')) return d;              // already country-coded
  if (d.startsWith('0'))  return '60' + d.slice(1);
  return '60' + d;                               // bare local -> assume MY
}

// EasyRoutes payloads name the Shopify order id differently across versions. Take the
// first plausible field and reduce a GID ('gid://shopify/Order/123') to the numeric id.
export function pickOrderId(p) {
  const cands = [
    p && p.order_id, p && p.shopify_order_id, p && p.shopifyOrderId,
    p && p.stop && p.stop.order_id, p && p.stop && p.stop.shopify_order_id,
    p && p.stop && p.stop.shopifyOrderId,
    p && p.order && p.order.id, p && p.order && p.order.admin_graphql_api_id,
    p && p.stop && p.stop.order && p.stop.order.id,
  ];
  for (const c of cands) {
    if (c == null) continue;
    const m = String(c).match(/(\d+)\s*$/);
    if (m) return m[1];
  }
  return null;
}

// Which delivery stage — prefer the topic header, fall back to payload fields.
export function pickEventType(p, topicHeader) {
  const t = String(
    topicHeader || (p && (p.topic || p.event || p.type)) || (p && p.stop && p.stop.status) || ''
  ).toLowerCase();
  if (/out[_\s-]?for[_\s-]?delivery|en[_\s-]?route/.test(t)) return 'out_for_delivery';
  if (/deliver|complete|done|arrived/.test(t))              return 'delivered';
  return null;
}

// Proof photo: check the EasyRoutes stop payload first, then the Shopify order
// note_attributes. Defensive on the attribute name — set EASYROUTES_PHOTO_ATTR to pin the
// exact key once known; otherwise match common photo/proof names.
export function pickPhotoUrl(order, payload, attrKeyEnv) {
  const isImg = u => typeof u === 'string' && /^https?:\/\/\S+/i.test(u);
  const direct = [
    payload && payload.photo_url, payload && payload.proof_photo_url,
    payload && payload.proofOfDeliveryPhotoUrl,
    payload && payload.stop && payload.stop.photo_url,
    payload && payload.stop && payload.stop.proof_of_delivery_photo_url,
  ].find(isImg);
  if (direct) return direct;
  const arr = (payload && payload.stop && payload.stop.photos) || (payload && payload.photos);
  if (Array.isArray(arr)) { const u = arr.map(x => (x && x.url) || x).find(isImg); if (u) return u; }
  const attrs = (order && order.note_attributes) || [];
  const wantKey = String(attrKeyEnv || '').toLowerCase();
  for (const a of attrs) {
    if (!a || !isImg(a.value)) continue;
    const name = String(a.name || '').toLowerCase();
    if (wantKey) { if (name === wantKey) return a.value; }
    else if (/(photo|proof|delivery.?image|\bpod\b)/.test(name)) return a.value;
  }
  return null;
}

export function firstNameOf(order) {
  const c = (order && order.customer) || {};
  return String(c.first_name || '').trim() || 'there';
}

// BUYER's own email only — order.email (checkout contact) else customer.email. Same privacy
// rule as the phone: never the shipping/billing recipient (a gift recipient must not be
// emailed the buyer's order details). Returns '' if there's no valid buyer email.
export function buyerEmailOf(order) {
  const e = (order && order.email) || (order && order.customer && order.customer.email) || '';
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(e).trim()) ? String(e).trim() : '';
}

// Read a Shopify note_attribute by name.
export function getAttr(order, name) {
  const a = ((order && order.note_attributes) || []).find(x => x && String(x.name).toLowerCase() === String(name).toLowerCase());
  return a ? a.value : '';
}
// Pickup / self-collect orders must NOT get the delivery templates (out for delivery /
// delivered by driver). Mirrors the app/webhook fulfilment-type parsing.
export function isPickupOrder(order) {
  const t = (getAttr(order, 'Order Fulfillment Type') || getAttr(order, 'Type Of Order') || '').toLowerCase();
  return /pick|collect/.test(t);
}

// EasyRoutes STOP_STATUS_UPDATED envelope: { objectId:<stop id>, payload:<route {stops[]}> }.
// Find the stop that changed (matched by objectId), map its deliveryStatus to our event
// type, and pull the Shopify order id + proof photo from the stop.
const ER_STATUS = {
  DELIVERED: 'delivered', DONE: 'delivered', COMPLETED: 'delivered',
  READY_FOR_DELIVERY: 'out_for_delivery', OUT_FOR_DELIVERY: 'out_for_delivery',
  EN_ROUTE: 'out_for_delivery', ON_THE_WAY: 'out_for_delivery', ACTIVE: 'out_for_delivery',
};
export function erExtract(envelope) {
  if (!envelope || typeof envelope !== 'object') return { type: null, orderId: null };
  const route = envelope.payload || {};
  const stops = Array.isArray(route.stops) ? route.stops : [];
  const stop = stops.find(s => s && s.id === envelope.objectId) || (stops.length === 1 ? stops[0] : null);
  if (!stop) return { type: null, orderId: null };
  const type = ER_STATUS[String(stop.deliveryStatus || '').toUpperCase()] || null;
  const orderId = String(stop.shopifyOrderId || '').split('/').pop().replace(/\D/g, '') || null;
  const pods = Array.isArray(stop.proofOfDeliveryPhotos) ? stop.proofOfDeliveryPhotos : [];
  const photo = pods.map(x => typeof x === 'string' ? x : (x && (x.url || x.src || x.photoUrl || x.link)))
                    .find(u => typeof u === 'string' && /^https?:\/\//i.test(u)) || null;
  // Delivery time for the email's rough "Delivered at" — prefer a stop-level completion field,
  // else the envelope's event timestamp (when the driver tapped Delivered).
  const at = stop.deliveredAt || stop.completedAt || stop.arrivedAt || stop.updatedAt || envelope.eventTimestamp || null;
  return { type, orderId, orderName: stop.orderName || null, status: stop.deliveryStatus || null, photo, at };
}

// Build the Meta template payload for a trigger. language 'en' (Chinese lives in the body
// of the approved template). Variable mapping per handoff.
// Per-template config, taken from the APPROVED definitions in WhatsApp Manager (read via
// /api/notify-test?inspect=1). All POSITIONAL vars. Each template carries a DYNAMIC url
// button, so the send MUST include a button parameter (index = the url button's position
// in the buttons array) or Meta returns (#131008) Required parameter is missing.
const TEMPLATES = {
  // Body {{1}}=name, {{2}}=order. Button is a static phone number (no send-time param).
  out_for_delivery:     { lang: 'en', body: ['name', 'orderNo'] },
  // TEXT header {{1}}=order, body has NO variables, URL button (index 0) = order status page.
  delivered_nophoto:    { lang: 'en', header: { type: 'text', vars: ['orderNo'] }, body: [], urlBtnIndex: 0 },
  // IMAGE header (proof photo), body {{1}}=order, URL button (index 0) = order status page.
  _delivered_withphoto: { lang: 'en', header: { type: 'image' }, body: ['orderNo'], urlBtnIndex: 0 },
};

export function buildTemplate(to, tpl, vars) {
  const cfg = TEMPLATES[tpl] || { lang: 'en', body: ['name', 'orderNo'] };
  const txt = k => ({ type: 'text', text: String(vars[k] == null ? '' : vars[k]) });
  const components = [];
  if (cfg.header && cfg.header.type === 'image') {
    // vars.photo is an R2-hosted public URL (WhatsApp can fetch it); EasyRoutes' own URL isn't.
    components.push({ type: 'header', parameters: [{ type: 'image', image: { link: vars.photo } }] });
  } else if (cfg.header && cfg.header.type === 'text') {
    components.push({ type: 'header', parameters: cfg.header.vars.map(txt) });
  }
  if (cfg.body && cfg.body.length) {
    components.push({ type: 'body', parameters: cfg.body.map(txt) });
  }
  if (cfg.urlBtnIndex != null) {
    // The dynamic {{1}} in the button base (https://bambooflorist.com.my/{{1}}). When we
    // have the order's status-URL suffix, pass it raw (it already contains /, ?, = and
    // must not be mangled). Fall back to a URL-safe order number if we don't.
    const raw = vars.btnParam != null
      ? String(vars.btnParam)
      : String(vars.orderNo || 'order').replace(/[^A-Za-z0-9._-]/g, '');
    components.push({ type: 'button', sub_type: 'url', index: String(cfg.urlBtnIndex),
      parameters: [{ type: 'text', text: raw.replace(/\s+/g, '') }] });
  }
  return { messaging_product: 'whatsapp', to, type: 'template', template: { name: tpl, language: { code: cfg.lang }, components } };
}

// WhatsApp can't use EasyRoutes' proof-photo URL directly (it 307-redirects to a ~59s-signed
// Google Cloud link), and a Meta-media-upload id doesn't render in this template. So download
// the image server-side (fetch follows the redirect) and re-host it on Cloudflare R2 — a
// stable public URL WhatsApp CAN fetch — returning that url for the image-header link. Returns
// null on any failure so the caller falls back to the text-only template.
export async function hostPhotoOnR2(imageUrl) {
  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, R2_PUBLIC_URL } = process.env;
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET || !R2_PUBLIC_URL) return null;
  try {
    const img = await fetch(imageUrl);
    if (!img.ok) return null;
    const ct = (img.headers.get('content-type') || 'image/jpeg').split(';')[0].trim();
    if (!/^image\//.test(ct)) return null;
    const bytes = Buffer.from(await img.arrayBuffer());
    const ext = (ct.split('/')[1] || 'jpg').replace('jpeg', 'jpg').replace(/[^a-z0-9]/gi, '');
    const key = `proof/${Date.now()}-${crypto.randomBytes(5).toString('hex')}.${ext}`;
    const client = new AwsClient({ accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY, service: 's3', region: 'auto' });
    const endpoint = `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${R2_BUCKET}/${key}`;
    const r2 = await client.fetch(endpoint, { method: 'PUT', body: bytes, headers: { 'Content-Type': ct, 'Content-Length': String(bytes.length) } });
    if (!r2.ok) return null;
    return `${String(R2_PUBLIC_URL).replace(/\/+$/, '')}/${key}`;
  } catch (_) { return null; }
}

/* ─── infra helpers ───────────────────────────────────────────────────────── */

function readRaw(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function safeEq(a, b) {
  const ba = Buffer.from(String(a || '')), bb = Buffer.from(String(b || ''));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}
async function logNote(sb, row) {
  try { await sb.from('wa_notifications').insert({ ...row, created_at: new Date().toISOString() }); }
  catch (e) { console.error('[notify] log failed:', e.message); }
}
async function csFlag(sb, orderId, orderNo, reason) {
  console.warn(`[notify] CS flag ${orderNo || orderId}: ${reason}`);
  await logNote(sb, { order_id: orderId, order_no: orderNo, status: 'cs_flag', error: reason });
}

// Send an email via Resend (single HTTPS POST, no SDK). from/reply-to come from env
// (NOTIFY_EMAIL_FROM / NOTIFY_EMAIL_REPLYTO). Returns { id } on success, or an error string so
// the caller can log + CS-flag. Never throws.
async function sendEmailViaResend(toEmail, msg) {
  const key  = process.env.RESEND_API_KEY;
  const from = process.env.NOTIFY_EMAIL_FROM;
  if (!key || !from) return 'resend_not_configured';
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from, to: toEmail, subject: msg.subject, html: msg.html, text: msg.text,
        reply_to: process.env.NOTIFY_EMAIL_REPLYTO || undefined,
      }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return (j && (j.message || (j.error && j.error.message))) || ('HTTP ' + r.status);
    return { id: (j && j.id) || null };
  } catch (e) { return e.message || 'email_send_error'; }
}

// Shopify Admin token via client_credentials (same mechanism as api/query.js), cached.
let _tok = null, _tokExp = 0, _tokShop = null;
function normShop(s) {
  s = String(s || '').trim().toLowerCase().replace(/^https?:\/\//, '');
  if (s && !s.includes('.')) s += '.myshopify.com';
  return s;
}
async function shopToken(shop) {
  const now = Date.now();
  if (_tok && _tokShop === shop && now < _tokExp) return _tok;
  const id = process.env.SHOPIFY_CLIENT_ID, secret = process.env.SHOPIFY_CLIENT_SECRET;
  if (!id || !secret) throw new Error('SHOPIFY_CLIENT_ID/SECRET missing');
  const r = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret }).toString(),
  });
  const j = await r.json().catch(() => ({}));
  if (!j.access_token) throw new Error(j.error_description || j.error || 'no access_token');
  _tok = j.access_token; _tokShop = shop;
  _tokExp = now + Math.max(60000, (j.expires_in ? j.expires_in * 1000 : 3600000) - 60000);
  return _tok;
}
// The order status page as a suffix under the button base (https://bambooflorist.com.my/{{1}}):
// strip scheme+host so only the per-order path+query remains.
export function statusUrlSuffix(order) {
  const u = order && order.order_status_url;
  if (!u) return null;
  try { const p = new URL(u); return (p.pathname + p.search).replace(/^\//, ''); }
  catch { return null; }
}

// Diagnostic: latest order's status URL, so we can shape the WhatsApp URL-button base.
export async function sampleOrderStatusUrl() {
  const shop = normShop(process.env.SHOPIFY_SHOP);
  if (!shop) throw new Error('SHOPIFY_SHOP missing');
  const token = await shopToken(shop);
  const r = await fetch(`https://${shop}/admin/api/2025-01/orders.json?limit=1&status=any&fields=id,name,order_status_url`,
    { headers: { 'X-Shopify-Access-Token': token, Accept: 'application/json' } });
  if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + (await r.text()).slice(0, 140));
  const j = await r.json();
  return (j.orders && j.orders[0]) || null;
}
export async function fetchShopifyOrder(orderId) {
  const shop = normShop(process.env.SHOPIFY_SHOP);
  if (!shop) throw new Error('SHOPIFY_SHOP missing');
  const token = await shopToken(shop);
  const url = `https://${shop}/admin/api/2025-01/orders/${orderId}.json`
            + `?fields=id,name,email,order_status_url,customer,note_attributes,phone,shipping_address,billing_address`
            + `,line_items,created_at,total_price,currency`;
  const r = await fetch(url, { headers: { 'X-Shopify-Access-Token': token, Accept: 'application/json' } });
  if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + (await r.text()).slice(0, 140));
  const j = await r.json();
  if (!j.order) throw new Error('order not found');
  return j.order;
}

/* ─── handler ─────────────────────────────────────────────────────────────── */

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!SB_URL || !SB_KEY)       return res.status(500).json({ error: 'Supabase env missing' });
  if (!WA_PHONE_ID || !WA_TOKEN) return res.status(500).json({ error: 'WhatsApp env missing' });

  const sb = createClient(SB_URL, SB_KEY);
  const raw = await readRaw(req);
  const debug = /^(1|true|yes|on)$/i.test(process.env.NOTIFY_DEBUG || '');

  // While wiring up EasyRoutes: trace every hit (structure only, no PII) so we can see
  // whether events arrive at all and which headers/topic they carry.
  if (debug) {
    let struct = null;
    try {
      const p = JSON.parse(raw.toString('utf8') || '{}');
      const pl = p.payload || {};
      const stops = Array.isArray(pl.stops) ? pl.stops : [];
      const st = stops.find(s => s && s.id === p.objectId) || stops[0] || {};
      const ord = st.order || {};
      struct = {
        topic: p.topic, objectId: p.objectId, nStops: stops.length,
        stopKeys: Object.keys(st),
        stopStatus: st.status || st.state || st.deliveryStatus || null,   // non-PII
        orderKeys: st.order ? Object.keys(ord) : null,
        idHints: {
          shopifyOrderId: st.shopifyOrderId || st.orderId || st.order_id || ord.shopifyOrderId || ord.id,
          orderName: st.orderName || st.name || ord.name,
        },
      };
    } catch (_) {}
    await logNote(sb, { status: 'debug_recv', error: JSON.stringify(struct).slice(0, 1400) });
  }

  // 1) Verify EasyRoutes signature over the raw body. EasyRoutes' webhook secret is
  // base64-encoded and signing uses the DECODED key bytes -> base64 digest (confirmed
  // via the b64dok trace).
  if (ER_SECRET) {
    const sig = req.headers['x-easyroutes-hmac-sha256'] || '';
    const key = Buffer.from(ER_SECRET, 'base64');
    const digest = crypto.createHmac('sha256', key).update(raw).digest('base64');
    if (!safeEq(sig, digest)) {
      await logNote(sb, { status: 'hmac_fail', error: `signature mismatch; header ${sig ? 'present' : 'absent'}` });
      return res.status(401).json({ error: 'Bad signature' });
    }
  }

  let payload;
  try { payload = JSON.parse(raw.toString('utf8') || '{}'); }
  catch { return res.status(400).json({ error: 'Bad JSON' }); }

  // 2) Dedupe on the event id — insert FIRST so a retry that arrives mid-processing can't
  //    trigger a second send. A unique-violation means we've already handled this event.
  const eventId = String(req.headers['x-easyroutes-event-id'] || (payload && payload.event_id) || '') || null;
  if (eventId) {
    const { error: dupErr } = await sb.from('wa_events').insert({ event_id: eventId });
    if (dupErr) return res.status(200).json({ ok: true, deduped: true });
  }

  // 3) Map the EasyRoutes STOP_STATUS_UPDATED event → event type + Shopify order id. Any
  //    other status (pending, skipped, …) or a non-stop event is ignored.
  const ext = erExtract(payload);
  const type = ext.type;
  const orderId = ext.orderId;
  if (!type || !orderId) {
    await logNote(sb, { order_id: orderId, status: 'skip',
      error: `unmapped topic=${payload && payload.topic} status=${ext.status} order=${orderId}` });
    return res.status(200).json({ ok: true, skipped: 'unmapped', status: ext.status, orderId });
  }

  // 4) Pull the authoritative Shopify order.
  let order;
  try { order = await fetchShopifyOrder(orderId); }
  catch (e) {
    await csFlag(sb, orderId, null, 'shopify_fetch_failed: ' + e.message);
    return res.status(200).json({ ok: false, error: 'shopify_fetch' }); // 200: logged for CS, no retry storm
  }
  const orderNo = (order && order.name) || ('#' + orderId);

  // 4b) Skip pickup / self-collect orders — delivery notifications don't apply to orders
  // the customer collects themselves.
  if (isPickupOrder(order)) {
    await logNote(sb, { order_id: orderId, order_no: orderNo, status: 'skip', error: 'pickup/self-collect order' });
    return res.status(200).json({ ok: true, skipped: 'pickup' });
  }

  // 5) BUYER's own contact only. Phone: customer.phone, else the order-level contact phone
  // (order.phone) — both the buyer (order.phone is the checkout contact, distinct from the
  // delivery address). Email: order.email, else customer.email. We NEVER read shipping_/
  // billing_address phone or email — those can be the gift RECIPIENT, who must never be
  // contacted. Need at least one channel; otherwise it's a CS flag.
  const to    = toE164MY((order.customer && order.customer.phone) || order.phone);
  const email = buyerEmailOf(order);

  // Test/gate env, read once.
  //  - NOTIFY_TEST_ORDERS (comma-sep order nos) → ONLY those orders actually send; else dry-run.
  //  - NOTIFY_TEST_PHONE → ONLY that number's WhatsApp sends; else dry-run.
  //  - NOTIFY_TEST_EMAIL → redirect ALL emails to this address (testing only).
  //  - NOTIFY_FORCE_EMAIL (comma-sep order nos, or truthy) → skip WhatsApp, send email only —
  //    for safely testing the email channel on a real order.
  //  - Otherwise → NOTIFY_ENABLED must be truthy, else dry-run (log only, nothing sent).
  const testOrders = (process.env.NOTIFY_TEST_ORDERS || '').split(',').map(s => s.trim().replace(/^#/, '')).filter(Boolean);
  const testPhone  = toE164MY(process.env.NOTIFY_TEST_PHONE || '');
  const testEmail  = (process.env.NOTIFY_TEST_EMAIL || '').trim();
  const enabled    = /^(1|true|yes|on)$/i.test(process.env.NOTIFY_ENABLED || '');
  const orderNum   = String(orderNo || '').replace(/^#/, '');
  const testMode   = testOrders.length > 0 || !!testPhone;
  const forceEmailEnv = (process.env.NOTIFY_FORCE_EMAIL || '').trim();
  const preferEmail = !!forceEmailEnv && (/^(1|true|yes|on)$/i.test(forceEmailEnv)
    || forceEmailEnv.split(',').map(s => s.trim().replace(/^#/, '')).includes(orderNum));
  const emailTo = testEmail || email;   // testEmail redirects the fallback during testing

  if (!to && !emailTo) {
    await csFlag(sb, orderId, orderNo, 'no_buyer_contact');
    return res.status(200).json({ ok: true, csFlag: 'no_buyer_contact' });
  }

  // 6) Resolve the proof photo → stable R2 link once (delivered only); shared by the WhatsApp
  // image template and the email. The WhatsApp *photo template* stays held behind
  // NOTIFY_PHOTO_ENABLED; the email always shows the photo when we have one.
  let photoLink = null;
  if (type === 'delivered') {
    const photo = ext.photo || pickPhotoUrl(order, {}, process.env.EASYROUTES_PHOTO_ATTR);
    if (photo) photoLink = await hostPhotoOnR2(photo);
  }

  // 6a) WhatsApp template + vars (only when the buyer has a phone). btnParam = order status
  // page suffix for the "View my order" button.
  const vars = { name: firstNameOf(order), orderNo, btnParam: statusUrlSuffix(order) || undefined };
  let tpl = null;
  if (to) {
    if (type === 'out_for_delivery') {
      tpl = 'out_for_delivery';
    } else {
      const photoEnabled = /^(1|true|yes|on)$/i.test(process.env.NOTIFY_PHOTO_ENABLED || '');
      if (photoEnabled && photoLink) { tpl = '_delivered_withphoto'; vars.photo = photoLink; }
      else                            tpl = 'delivered_nophoto';
    }
  }

  // 6b) SEND GATE (applies to both channels).
  let allow, gate;
  if (testOrders.length) { allow = testOrders.includes(orderNum); gate = 'test-order'; }
  else if (testPhone)    { allow = (to === testPhone);            gate = 'test-phone'; }
  else                   { allow = enabled;                        gate = null; }
  if (!allow) {
    await logNote(sb, { order_id: orderId, order_no: orderNo, template: tpl || ('email:' + type), phone: to || emailTo,
      status: 'dryrun', error: gate ? (gate + '-gated') : null });
    return res.status(200).json({ ok: true, dryRun: true, template: tpl, to: to || emailTo });
  }

  // 6c) De-dupe per (order, stage, CHANNEL). EasyRoutes fires STOP_STATUS_UPDATED several
  //     times per stop, so each channel is claimed once — but WhatsApp and email are claimed
  //     INDEPENDENTLY, so a buyer who gave both gets ONE WhatsApp *and* ONE email per stage.
  //     Claimed BEFORE sending. Skipped in test mode so an order can be re-triggered.
  const claim = async (ch) => {
    if (testMode) return true;
    const { error } = await sb.from('wa_events').insert({ event_id: `${orderId}:${type}:${ch}` });
    return !error;                       // false => this channel already handled for this stage
  };

  // 7) Send WhatsApp AND email — both fire when the buyer provided both a phone and an email
  //    (independent channels, not fallback). Each sends whichever detail exists.
  let waSent = false, waErr = null, waMsgId = null, waTried = false;
  let emSent = false, emErr = null, emMsgId = null, emTried = false;

  // 7a) WhatsApp (buyer has a phone). NOTIFY_FORCE_EMAIL skips it for email-only testing.
  if (to && tpl && !preferEmail && await claim('wa')) {
    waTried = true;
    try {
      const r = await fetch(`https://graph.facebook.com/${GRAPH_VER}/${WA_PHONE_ID}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${WA_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(buildTemplate(to, tpl, vars)),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) waErr = (j && j.error && j.error.message) || ('HTTP ' + r.status);
      else { waMsgId = j && j.messages && j.messages[0] && j.messages[0].id; waSent = true; }
    } catch (e) { waErr = e.message; }
    if (waSent) await logNote(sb, { order_id: orderId, order_no: orderNo, template: tpl, phone: to, meta_message_id: waMsgId, status: 'sent' });
    else        await logNote(sb, { order_id: orderId, order_no: orderNo, template: tpl, phone: to, status: 'error', error: waErr });
  }

  // 7b) Email (buyer has an email). Theme-matched HTML (Bamboo Green storefront palette/fonts)
  //     via the ported templates — full order summary, care tips, proof photo, status link.
  if (emailTo && await claim('email')) {
    emTried = true;
    const msg = buildOrderEmail(type, order, { photoLink, statusUrl: order.order_status_url, deliveredAt: ext.at });
    const r = await sendEmailViaResend(emailTo, msg);
    if (r && typeof r === 'object') { emSent = true; emMsgId = r.id; }
    else emErr = String(r);
    if (emSent) await logNote(sb, { order_id: orderId, order_no: orderNo, template: 'email:' + type, phone: emailTo, meta_message_id: emMsgId, status: 'sent' });
    else        await logNote(sb, { order_id: orderId, order_no: orderNo, template: 'email:' + type, phone: emailTo, status: 'error', error: 'email_failed: ' + emErr });
  }

  // 8) Outcome. CS-flag only if the customer ended up with NOTHING despite an attempt (a pure
  //    de-dupe — every channel already sent earlier — is not a failure).
  const delivered = [];
  if (waSent) delivered.push('whatsapp');
  if (emSent) delivered.push('email');
  if (!delivered.length) {
    if (waTried || emTried) {
      const why = [waErr && 'wa:' + waErr, emErr && 'email:' + emErr].filter(Boolean).join(' | ');
      await csFlag(sb, orderId, orderNo, 'all_channels_failed: ' + why);
      return res.status(200).json({ ok: false, error: why || 'send_failed' });
    }
    return res.status(200).json({ ok: true, deduped: type });   // already notified earlier
  }
  return res.status(200).json({ ok: true, channels: delivered, whatsapp: waMsgId, email: emMsgId });
}
