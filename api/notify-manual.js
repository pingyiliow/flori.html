// POST /api/notify-manual  { orderId, photoUrl?, authToken }
// Staff-initiated DELIVERED notification from the BloomFlow app — when staff hit "Mark
// Delivered" and choose to notify the customer (optionally with a proof photo they uploaded).
// Sends the SAME WhatsApp + email as the EasyRoutes path (api/notify.js), buyer contact ONLY,
// deduped per (order, delivered, channel) so it can never double with an EasyRoutes event that
// already fired. This is the manual counterpart to the webhook — out_for_delivery stays
// EasyRoutes-only; this endpoint only sends the delivered stage.
//
// AUTH: the caller's Supabase staff JWT (verified via /auth/v1/user, same as api/query.js). No
// valid session → 401. Unlike the webhook it does NOT check NOTIFY_ENABLED / NOTIFY_TEST_* —
// an authenticated staff member explicitly clicked "notify", so that IS the authorization.

import { createClient } from '@supabase/supabase-js';
import {
  toE164MY, buildTemplate, firstNameOf, buyerEmailOf, statusUrlSuffix,
  fetchShopifyOrder, isPickupOrder, hostPhotoOnR2,
} from './notify.js';
import { buildOrderEmail } from './_emailTemplates.js';

// URL + anon key mirror api/query.js (the anon key is public — it's embedded in the page —
// so the fallback is not a secret; it just makes JWT verification work without extra config).
const SB_URL  = process.env.SUPABASE_URL  || 'https://oyrngwazbqmxoeihyfoy.supabase.co';
const SB_ANON = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im95cm5nd2F6YnFteG9laWh5Zm95Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA3MzQ1MjksImV4cCI6MjA5NjMxMDUyOX0.SFySJvTDJCa2in9r_Rvvg5akPMEhGloCS6H08RtPOPE';
const SB_KEY  = process.env.SUPABASE_SERVICE_KEY;
const WA_PHONE_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const WA_TOKEN    = process.env.WHATSAPP_ACCESS_TOKEN;
const GRAPH_VER   = 'v21.0';

async function verifyStaff(jwt) {
  if (!jwt || !SB_URL || !SB_ANON) return false;
  try {
    const r = await fetch(`${SB_URL}/auth/v1/user`, { headers: { apikey: SB_ANON, Authorization: `Bearer ${jwt}` } });
    if (!r.ok) return false;
    const u = await r.json().catch(() => null);
    return !!(u && u.id);
  } catch { return false; }
}

async function logNote(sb, row) {
  try { await sb.from('wa_notifications').insert({ ...row, created_at: new Date().toISOString() }); }
  catch (e) { console.error('[notify-manual] log failed:', e.message); }
}

async function sendEmailViaResend(toEmail, msg) {
  const key = process.env.RESEND_API_KEY, from = process.env.NOTIFY_EMAIL_FROM;
  if (!key || !from) return 'resend_not_configured';
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: toEmail, subject: msg.subject, html: msg.html, text: msg.text,
        reply_to: process.env.NOTIFY_EMAIL_REPLYTO || undefined }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return (j && (j.message || (j.error && j.error.message))) || ('HTTP ' + r.status);
    return { id: (j && j.id) || null };
  } catch (e) { return e.message || 'email_send_error'; }
}

// Is this proof-photo URL already a public R2 link the WhatsApp/Meta fetcher can reach?
function isPublicR2(url) {
  const pub = process.env.R2_PUBLIC_URL || '';
  if (pub && url.startsWith(pub)) return true;
  return /r2\.dev|r2\.cloudflarestorage/.test(url);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!SB_URL || !SB_KEY)       return res.status(500).json({ error: 'Supabase env missing' });
  if (!WA_PHONE_ID || !WA_TOKEN) return res.status(500).json({ error: 'WhatsApp env missing' });

  let body = {};
  try { body = typeof req.body === 'object' && req.body ? req.body : JSON.parse(req.body || '{}'); } catch {}
  const jwt = body.authToken || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!(await verifyStaff(jwt))) return res.status(401).json({ error: 'Not authenticated' });

  const orderId = String(body.orderId || '').split('/').pop().replace(/\D/g, '');
  if (!orderId) return res.status(400).json({ error: 'orderId required' });
  const type = 'delivered';
  const photoIn = (typeof body.photoUrl === 'string' && /^https?:\/\//i.test(body.photoUrl)) ? body.photoUrl : null;

  const sb = createClient(SB_URL, SB_KEY);

  let order;
  try { order = await fetchShopifyOrder(orderId); }
  catch (e) { return res.status(200).json({ ok: false, error: 'shopify_fetch: ' + e.message }); }
  const orderNo = order.name || ('#' + orderId);

  // Pickup / self-collect never gets a delivery notification.
  if (isPickupOrder(order)) return res.status(200).json({ ok: true, skipped: 'pickup' });

  // BUYER contact only (same invariant as the webhook) — never the shipping/billing recipient.
  const to    = toE164MY((order.customer && order.customer.phone) || order.phone);
  const email = buyerEmailOf(order);
  if (!to && !email) {
    await logNote(sb, { order_id: orderId, order_no: orderNo, status: 'cs_flag', error: 'no_buyer_contact (manual)' });
    return res.status(200).json({ ok: true, csFlag: 'no_buyer_contact' });
  }

  // Proof photo: the app already uploaded it to R2, so the URL is public + Meta-fetchable.
  // Re-host defensively only if it's on some other host.
  let photoLink = null;
  if (photoIn) photoLink = isPublicR2(photoIn) ? photoIn : ((await hostPhotoOnR2(photoIn)) || photoIn);

  // One notification per (order, delivered, channel) across BOTH the webhook and this manual
  // path — claim BEFORE sending. If EasyRoutes already sent, the claim fails → skip (no double).
  const claim = async (ch) => { const { error } = await sb.from('wa_events').insert({ event_id: `${orderId}:${type}:${ch}` }); return !error; };

  const vars = { name: firstNameOf(order), orderNo, btnParam: statusUrlSuffix(order) || undefined };
  const tpl = photoLink ? '_delivered_withphoto' : 'delivered_nophoto';
  if (photoLink) vars.photo = photoLink;

  let waSent = false, waErr = null, waId = null, waDup = false;
  let emSent = false, emErr = null, emId = null, emDup = false;

  if (to) {
    if (await claim('wa')) {
      try {
        const r = await fetch(`https://graph.facebook.com/${GRAPH_VER}/${WA_PHONE_ID}/messages`, {
          method: 'POST', headers: { Authorization: `Bearer ${WA_TOKEN}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(buildTemplate(to, tpl, vars)),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) waErr = (j && j.error && j.error.message) || ('HTTP ' + r.status);
        else { waId = j && j.messages && j.messages[0] && j.messages[0].id; waSent = true; }
      } catch (e) { waErr = e.message; }
      await logNote(sb, { order_id: orderId, order_no: orderNo, template: tpl, phone: to, meta_message_id: waId, status: waSent ? 'sent' : 'error', error: waSent ? 'manual' : waErr });
    } else { waDup = true; }
  }

  if (email) {
    if (await claim('email')) {
      const msg = buildOrderEmail(type, order, { photoLink, statusUrl: order.order_status_url });
      const r = await sendEmailViaResend(email, msg);
      if (r && typeof r === 'object') { emSent = true; emId = r.id; } else emErr = String(r);
      await logNote(sb, { order_id: orderId, order_no: orderNo, template: 'email:' + type, phone: email, meta_message_id: emId, status: emSent ? 'sent' : 'error', error: emSent ? 'manual' : ('email_failed: ' + emErr) });
    } else { emDup = true; }
  }

  const channels = [];
  if (waSent) channels.push('whatsapp');
  if (emSent) channels.push('email');
  return res.status(200).json({
    ok: channels.length > 0 || waDup || emDup,
    channels, orderNo,
    alreadySent: (waDup || emDup) && !channels.length,   // EasyRoutes (or a prior manual send) beat us to it
    errors: [waErr && 'wa:' + waErr, emErr && 'email:' + emErr].filter(Boolean),
  });
}
