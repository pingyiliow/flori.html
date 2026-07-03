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
// GO-LIVE GATES (env): NOTIFY_ENABLED must be truthy to actually send — otherwise every
// event is processed + logged (status 'dryrun') but NOTHING is sent, so the webhook can be
// wired/verified safely. NOTIFY_PHOTO_ENABLED separately holds photo messages: while off,
// deliveries use the text-only template even when a proof photo exists.

import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

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
  // IMAGE header (proof photo), body {{1}}=order, URL button (index 1) = order status page.
  delivered_with_photo: { lang: 'en', header: { type: 'image' }, body: ['orderNo'], urlBtnIndex: 1 },
};

export function buildTemplate(to, tpl, vars) {
  const cfg = TEMPLATES[tpl] || { lang: 'en', body: ['name', 'orderNo'] };
  const txt = k => ({ type: 'text', text: String(vars[k] == null ? '' : vars[k]) });
  const components = [];
  if (cfg.header && cfg.header.type === 'image') {
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
async function fetchShopifyOrder(orderId) {
  const shop = normShop(process.env.SHOPIFY_SHOP);
  if (!shop) throw new Error('SHOPIFY_SHOP missing');
  const token = await shopToken(shop);
  const url = `https://${shop}/admin/api/2025-01/orders/${orderId}.json`
            + `?fields=id,name,order_status_url,customer,note_attributes`;
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

  const raw = await readRaw(req);

  // 1) Verify EasyRoutes signature over the raw body.
  if (ER_SECRET) {
    const sig = req.headers['x-easyroutes-hmac-sha256'] || '';
    const digest = crypto.createHmac('sha256', ER_SECRET).update(raw).digest('base64');
    if (!safeEq(sig, digest)) return res.status(401).json({ error: 'Bad signature' });
  }

  let payload;
  try { payload = JSON.parse(raw.toString('utf8') || '{}'); }
  catch { return res.status(400).json({ error: 'Bad JSON' }); }

  const sb = createClient(SB_URL, SB_KEY);

  // 2) Dedupe on the event id — insert FIRST so a retry that arrives mid-processing can't
  //    trigger a second send. A unique-violation means we've already handled this event.
  const eventId = String(req.headers['x-easyroutes-event-id'] || (payload && payload.event_id) || '') || null;
  if (eventId) {
    const { error: dupErr } = await sb.from('wa_events').insert({ event_id: eventId });
    if (dupErr) return res.status(200).json({ ok: true, deduped: true });
  }

  // 3) Map the event.
  const type    = pickEventType(payload, req.headers['x-easyroutes-topic']);
  const orderId = pickOrderId(payload);
  if (!type || !orderId) {
    await logNote(sb, { order_id: orderId, status: 'skip', error: `unmapped type=${type} order=${orderId}` });
    return res.status(200).json({ ok: true, skipped: 'unmapped', type, orderId });
  }

  // 4) Pull the authoritative Shopify order.
  let order;
  try { order = await fetchShopifyOrder(orderId); }
  catch (e) {
    await csFlag(sb, orderId, null, 'shopify_fetch_failed: ' + e.message);
    return res.status(200).json({ ok: false, error: 'shopify_fetch' }); // 200: logged for CS, no retry storm
  }
  const orderNo = (order && order.name) || ('#' + orderId);

  // 5) PRIVACY GATE — customer.phone ONLY. Nothing else is ever read as a recipient.
  const to = toE164MY(order.customer && order.customer.phone);
  if (!to) {
    await csFlag(sb, orderId, orderNo, 'no_customer_phone');
    return res.status(200).json({ ok: true, csFlag: 'no_customer_phone' });
  }

  // 6) Choose the template. btnParam = order status page suffix for the "View my order" button.
  const vars = { name: firstNameOf(order), orderNo, btnParam: statusUrlSuffix(order) || undefined };
  let tpl;
  if (type === 'out_for_delivery') {
    tpl = 'out_for_delivery';
  } else {
    // Photo messages are held behind NOTIFY_PHOTO_ENABLED — until it's on, deliveries use
    // the text-only template even when a proof photo exists.
    const photoEnabled = /^(1|true|yes|on)$/i.test(process.env.NOTIFY_PHOTO_ENABLED || '');
    const photo = photoEnabled ? pickPhotoUrl(order, payload, process.env.EASYROUTES_PHOTO_ATTR) : null;
    if (photo) { tpl = 'delivered_with_photo'; vars.photo = photo; }
    else         tpl = 'delivered_nophoto';
  }

  // 6b) MASTER GO-LIVE GATE. Until NOTIFY_ENABLED is set, process + log but send nothing —
  // lets the EasyRoutes webhook be wired and verified without messaging real customers.
  const enabled = /^(1|true|yes|on)$/i.test(process.env.NOTIFY_ENABLED || '');
  if (!enabled) {
    await logNote(sb, { order_id: orderId, order_no: orderNo, template: tpl, phone: to, status: 'dryrun' });
    return res.status(200).json({ ok: true, dryRun: true, template: tpl, to });
  }

  // 7) Send via Meta Cloud API (inline).
  let metaMsgId = null, sendErr = null;
  try {
    const r = await fetch(`https://graph.facebook.com/${GRAPH_VER}/${WA_PHONE_ID}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${WA_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(buildTemplate(to, tpl, vars)),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) sendErr = (j && j.error && j.error.message) || ('HTTP ' + r.status);
    else metaMsgId = j && j.messages && j.messages[0] && j.messages[0].id;
  } catch (e) { sendErr = e.message; }

  // 8) Log / flag.
  if (sendErr) {
    await logNote(sb, { order_id: orderId, order_no: orderNo, template: tpl, phone: to, status: 'error', error: sendErr });
    await csFlag(sb, orderId, orderNo, 'meta_send_failed: ' + sendErr);
    return res.status(200).json({ ok: false, error: sendErr });
  }
  await logNote(sb, { order_id: orderId, order_no: orderNo, template: tpl, phone: to, meta_message_id: metaMsgId, status: 'sent' });
  return res.status(200).json({ ok: true, template: tpl, messageId: metaMsgId });
}
