// GET /api/notify-test?secret=...&to=0164129499&template=both
// Manual test harness for the notify module — sends the approved WhatsApp templates to a given
// number, OR (?emailtest=1&to=you@x.com&type=delivered) sends a real delivery EMAIL via Resend
// so you can eyeball it and confirm it lands in the Resend dashboard. NOT part of the live flow.
// Guarded by NOTIFY_TEST_SECRET so it can't be abused. Safe to delete after testing.
//
// Uses the same env + helpers as api/notify.js (WHATSAPP_PHONE_NUMBER_ID/ACCESS_TOKEN).
// Templates: out_for_delivery_bg, delivered_with_photo, delivered_no_photo_bg.

import { createClient } from '@supabase/supabase-js';
import { toE164MY, buildTemplate, sampleOrderStatusUrl, statusUrlSuffix,
         fetchShopifyOrder, pickPhotoUrl, firstNameOf, getAttr, isPickupOrder,
         hostPhotoOnR2 } from './notify.js';
import { buildOrderEmail } from './_emailTemplates.js';

const WA_PHONE_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const WA_TOKEN    = process.env.WHATSAPP_ACCESS_TOKEN;
const GRAPH_VER   = 'v21.0';

// A public, direct https image just for the photo-template test (Meta needs a reachable
// image URL). Override with &photo=<url>.
const SAMPLE_PHOTO = 'https://images.unsplash.com/photo-1490750967868-88aa4486c946?w=900&q=80&fm=jpg';

// Built-in sample order for the email test when no real ?order= is given — exercises money
// formatting, delivery attributes, address, and the care-tips engine (bouquet + cake urgent).
const SAMPLE_ORDER = {
  name: '#TEST', email: 'test@example.com', created_at: '2026-07-12T10:30:00+08:00',
  currency: 'MYR', total_price: '288.00',
  order_status_url: 'https://bambooflorist.com.my/orders/status/sample',
  customer: { first_name: 'Wei Ling' },
  note_attributes: [
    { name: 'Order Due Date', value: '13 Jul 2026' }, { name: 'Order Due Time', value: '2:00 PM – 6:00 PM' },
    { name: 'recipient_name', value: 'Emily Tan' }, { name: 'recipient_phone', value: '+60 12-345 6789' },
  ],
  shipping_address: { name: 'Emily Tan', phone: '+60 12-345 6789', address1: '12 Jalan Mawar',
    address2: 'Taman Bunga', zip: '14000', city: 'Bukit Mertajam', province: 'Penang' },
  line_items: [
    { title: 'Rose & Eustoma Hand Bouquet', quantity: 1, price: '188.00', product_type: 'Hand Bouquet' },
    { title: 'Chocolate Fudge Cake 6"', quantity: 1, price: '100.00', product_type: 'Cake' },
  ],
};

// Send one email via Resend (same call the live notify.js makes). Returns a plain result object.
async function sendEmailRaw(to, msg) {
  const key = process.env.RESEND_API_KEY, from = process.env.NOTIFY_EMAIL_FROM;
  if (!key || !from) return { ok: false, error: 'resend_not_configured — set RESEND_API_KEY + NOTIFY_EMAIL_FROM in Vercel' };
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to, subject: msg.subject, html: msg.html, text: msg.text,
        reply_to: process.env.NOTIFY_EMAIL_REPLYTO || undefined }),
    });
    const j = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, id: (j && j.id) || null,
      error: r.ok ? null : ((j && (j.message || (j.error && j.error.message))) || ('HTTP ' + r.status)) };
  } catch (e) { return { ok: false, error: e.message }; }
}

async function sendTemplate(to, tpl, vars) {
  const r = await fetch(`https://graph.facebook.com/${GRAPH_VER}/${WA_PHONE_ID}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${WA_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(buildTemplate(to, tpl, vars)),
  });
  const j = await r.json().catch(() => ({}));
  return {
    template: tpl,
    ok: r.ok,
    status: r.status,
    messageId: (j && j.messages && j.messages[0] && j.messages[0].id) || null,
    error: r.ok ? null : ((j && j.error && j.error.message) || ('HTTP ' + r.status)),
  };
}

export default async function handler(req, res) {
  const q = req.query || {};
  if (!process.env.NOTIFY_TEST_SECRET || q.secret !== process.env.NOTIFY_TEST_SECRET) {
    return res.status(401).json({ error: 'Bad or missing secret' });
  }
  // Logs mode: read recent wa_notifications rows (service key, so RLS never hides them).
  if (q.logs) {
    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const { data, error } = await sb.from('wa_notifications')
      .select('*').order('created_at', { ascending: false }).limit(Number(q.n) || 15);
    return res.status(200).json({ error: error && error.message, rows: data || [] });
  }

  // EMAIL TEST: render + actually send a delivery email via Resend, so you can eyeball it in
  // your inbox and see it land in the Resend dashboard — no EasyRoutes event needed.
  //   ?emailtest=1&to=you@x.com&type=delivered            → built-in sample order
  //   ?emailtest=1&to=you@x.com&type=out_for_delivery
  //   ?emailtest=1&to=you@x.com&order=121234&type=delivered → real order's data + real photo
  if (q.emailtest) {
    const to = String(q.to || '').trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return res.status(400).json({ error: 'Pass ?to=<email>' });
    const type = q.type === 'out_for_delivery' ? 'out_for_delivery' : 'delivered';
    let order = SAMPLE_ORDER, source = 'sample order', photoLink = (type === 'delivered' ? (q.photo || SAMPLE_PHOTO) : null);
    if (q.order) {
      try {
        const sbc = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
        const arg = String(q.order).replace(/^#/, '');
        const { data } = await sbc.from('orders').select('id').or(`name.eq.#${arg},name.eq.${arg}`).limit(1);
        const orderId = (data && data[0] && data[0].id) || (/^\d{10,}$/.test(arg) ? arg : null);
        if (!orderId) return res.status(200).json({ error: 'order not found: ' + q.order });
        order = await fetchShopifyOrder(orderId);
        source = 'order ' + order.name;
        photoLink = null;
        if (type === 'delivered') { const p = pickPhotoUrl(order, {}, process.env.EASYROUTES_PHOTO_ATTR); if (p) photoLink = await hostPhotoOnR2(p); }
      } catch (e) { return res.status(200).json({ error: String(e && e.message || e) }); }
    }
    const msg = buildOrderEmail(type, order, { photoLink, statusUrl: order.order_status_url });
    const resend = await sendEmailRaw(to, msg);
    return res.status(200).json({ source, type, to, subject: msg.subject, photoLink: photoLink || null, htmlBytes: msg.html.length, resend });
  }

  if (!WA_PHONE_ID || !WA_TOKEN) return res.status(500).json({ error: 'WhatsApp env missing' });

  // Sample mode: show a real order's status URL so we can shape the URL-button base.
  if (q.sampleorder) {
    try { return res.status(200).json({ order: await sampleOrderStatusUrl() }); }
    catch (e) { return res.status(200).json({ error: e.message }); }
  }

  // Simulate mode: run the live delivery logic for a real order WITHOUT the EasyRoutes
  // webhook — show which phone/template/link it resolves (privacy gate included). Does NOT
  // message the real customer. Pass &to=<test phone> to send a COPY to that number.
  if (q.simulate) {
    try {
      const sbc = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
      const arg = String(q.simulate).replace(/^#/, '');
      // Resolve the order NUMBER (#118352) to its Shopify internal id via the synced table.
      let orderId = null;
      const { data } = await sbc.from('orders').select('id,name').or(`name.eq.#${arg},name.eq.${arg}`).limit(1);
      orderId = data && data[0] && data[0].id;
      if (!orderId && /^\d{10,}$/.test(arg)) orderId = arg;   // fallback: arg is itself a Shopify id
      if (!orderId) return res.status(200).json({ error: 'Order not found in synced table: ' + q.simulate });
      const order = await fetchShopifyOrder(orderId);
      const type = q.type === 'out_for_delivery' ? 'out_for_delivery' : 'delivered';
      const to = toE164MY((order.customer && order.customer.phone) || order.phone);

      let tpl = null, photo = null, photoHosted = null;
      if (to) {
        if (type === 'out_for_delivery') tpl = 'out_for_delivery';
        else {
          photo = pickPhotoUrl(order, {}, process.env.EASYROUTES_PHOTO_ATTR);
          if (photo) photoHosted = await hostPhotoOnR2(photo);
          tpl = photoHosted ? '_delivered_withphoto' : 'delivered_nophoto';
        }
      }
      const out = {
        orderNo: order.name, orderId, event: type,
        phones: {   // diagnostic only — the live gate uses ONLY customer.phone
          customer_phone: (order.customer && order.customer.phone) || null,
          order_phone: order.phone || null,
          shipping_phone: (order.shipping_address && order.shipping_address.phone) || null,
          billing_phone: (order.billing_address && order.billing_address.phone) || null,
        },
        customerPhone: (order.customer && order.customer.phone) || null,
        wouldSendTo: to || null,
        privacyGate: to ? 'OK — buyer phone present' : 'BLOCKED — no buyer phone → CS flag, nothing sent',
        template: tpl,
        buttonOpens: statusUrlSuffix(order) ? ('https://bambooflorist.com.my/' + statusUrlSuffix(order)) : null,
        fulfillmentType: getAttr(order, 'Order Fulfillment Type') || getAttr(order, 'Type Of Order') || null,
        isPickup_wouldSkip: isPickupOrder(order),
        noteAttrs: (order.note_attributes || []).map(a => a.name),
        photoAttrFound: !!photo,
        photoUrl: photo || null,
        photoHostedOnR2: photoHosted || null,
      };
      if (q.to && to) {
        const dest = toE164MY(q.to);
        const vars = { name: firstNameOf(order), orderNo: order.name, btnParam: statusUrlSuffix(order) || undefined, photo: photoHosted || photo };
        const r = await fetch(`https://graph.facebook.com/${GRAPH_VER}/${WA_PHONE_ID}/messages`, {
          method: 'POST', headers: { Authorization: `Bearer ${WA_TOKEN}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(buildTemplate(dest, tpl, vars)),
        });
        const j = await r.json().catch(() => ({}));
        out.sentCopyTo = { to: dest, ok: r.ok, messageId: (j && j.messages && j.messages[0] && j.messages[0].id) || null, error: r.ok ? null : ((j && j.error && j.error.message) || ('HTTP ' + r.status)) };
      }
      return res.status(200).json(out);
    } catch (e) { return res.status(200).json({ error: String(e && e.message || e) }); }
  }

  // Photo diagnostic: fetch a real order's proof photo and show exactly what came back
  // (final URL after redirect, content-type, size, magic bytes) + the Meta /media result.
  if (q.diagphoto) {
    try {
      const sbc = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
      const arg = String(q.diagphoto).replace(/^#/, '');
      const { data } = await sbc.from('orders').select('id').or(`name.eq.#${arg},name.eq.${arg}`).limit(1);
      const orderId = (data && data[0] && data[0].id) || (/^\d{10,}$/.test(arg) ? arg : null);
      if (!orderId) return res.status(200).json({ error: 'order not found' });
      const order = await fetchShopifyOrder(orderId);
      const photoUrl = pickPhotoUrl(order, {}, process.env.EASYROUTES_PHOTO_ATTR);
      if (!photoUrl) return res.status(200).json({ error: 'no photo attr on order' });
      const img = await fetch(photoUrl);
      const ct = img.headers.get('content-type');
      const buf = Buffer.from(await img.arrayBuffer());
      let meta = null;
      if (/^image\//.test((ct || '').split(';')[0])) {
        const form = new FormData();
        form.append('messaging_product', 'whatsapp');
        form.append('type', (ct || 'image/jpeg').split(';')[0].trim());
        form.append('file', new Blob([buf], { type: ct }), 'p.jpg');
        const up = await fetch(`https://graph.facebook.com/${GRAPH_VER}/${WA_PHONE_ID}/media`,
          { method: 'POST', headers: { Authorization: `Bearer ${WA_TOKEN}` }, body: form });
        meta = await up.json().catch(() => ({}));
      }
      return res.status(200).json({
        photoUrl, finalUrl: img.url, redirected: img.redirected, status: img.status,
        contentType: ct, bytes: buf.length, magic: buf.slice(0, 4).toString('hex'), metaMedia: meta,
      });
    } catch (e) { return res.status(200).json({ error: String(e && e.message || e) }); }
  }

  // Inspect mode: read the real template definitions from Meta so we can match the send
  // payload exactly (named vs positional params, variable count, components).
  if (q.inspect) {
    const waba = process.env.WHATSAPP_WABA_ID;
    if (!waba) return res.status(400).json({ error: 'Set WHATSAPP_WABA_ID env to inspect templates' });
    const r = await fetch(`https://graph.facebook.com/${GRAPH_VER}/${waba}/message_templates?fields=name,language,status,category,parameter_format,components&limit=50`,
      { headers: { Authorization: `Bearer ${WA_TOKEN}` } });
    const j = await r.json().catch(() => ({}));
    const rows = (j && j.data) || [];
    const slim = rows.map(t => ({
      name: t.name, language: t.language, status: t.status,
      parameter_format: t.parameter_format || '(positional/legacy)',
      components: (t.components || []).map(c => ({
        type: c.type, format: c.format,
        text: c.text,
        example: c.example,
        buttons: c.buttons && c.buttons.map(b => ({ type: b.type, text: b.text, url: b.url, phone_number: b.phone_number, example: b.example })),
      })),
    }));
    return res.status(200).json({ error: j && j.error, templates: slim });
  }

  const to = toE164MY(q.to);
  if (!to) return res.status(400).json({ error: 'Pass ?to=<phone> (e.g. 0164129499)' });

  const which = String(q.template || 'both').toLowerCase();
  const photo = q.photo || SAMPLE_PHOTO;
  const name  = q.name || 'Test';
  const orderNo = q.order || '#TEST';

  // Use a real order's status-page suffix for the "View my order" button (unless &btn= given),
  // so the test button opens an actual order status page.
  let btnParam = q.btn;
  if (btnParam == null) { try { btnParam = statusUrlSuffix(await sampleOrderStatusUrl()); } catch (_) {} }

  // Default 'both' = the two templates that are ready (out_for_delivery + delivered_with_photo).
  const jobs = [];
  if (which === 'out_for_delivery' || which === 'both' || which === 'all')
    jobs.push(['out_for_delivery', { name, orderNo, btnParam }]);
  if (which === 'delivered_photo' || which === 'both' || which === 'all')
    jobs.push(['_delivered_withphoto', { orderNo, photo, btnParam }]);
  if (which === 'delivered_nophoto' || which === 'all')
    jobs.push(['delivered_nophoto', { name, orderNo, btnParam }]);

  if (!jobs.length) return res.status(400).json({ error: 'Unknown template: ' + which });

  const results = [];
  for (const [tpl, vars] of jobs) {
    try { results.push(await sendTemplate(to, tpl, vars)); }
    catch (e) { results.push({ template: tpl, ok: false, error: e.message }); }
  }
  return res.status(200).json({ to, sent: results });
}
