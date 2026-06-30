// POST /api/webhook
// Receives Shopify order webhooks and saves to Supabase

import { createClient } from '@supabase/supabase-js';

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;

// Parse a free-text delivery date into an ISO 'YYYY-MM-DD' string (or null).
// Mirrors pd() in flori.html so the `due_on` date column the app filters on stays
// consistent whether an order arrives via webhook or is saved in the app.
const _MN = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 };
function parseDueOn(s) {
  if (!s) return null;
  s = String(s).trim();
  const iso = (y, mo, d) => `${y}-${String(mo + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const yr = new Date().getFullYear();
  let m;
  // ISO (with or without time)
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);                       if (m) return iso(+m[1], +m[2] - 1, +m[3]);
  // D/M/YYYY · D-M-YYYY · D.M.YYYY
  m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);      if (m) return iso(+m[3], +m[2] - 1, +m[1]);
  // D/M/YY
  m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2})$/);      if (m) return iso(2000 + +m[3], +m[2] - 1, +m[1]);
  // [Weekday ,] D Mon YYYY  (handles "Wed, 9 Jul 2025" and "Friday , 29 May 2026")
  m = s.match(/(?:[A-Za-z]+\s*,?\s+)?(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/);
  if (m) { const mo = _MN[m[2].toLowerCase().slice(0, 3)]; if (mo != null) return iso(+m[3], mo, +m[1]); }
  // Mon D, YYYY
  m = s.match(/^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})$/);
  if (m) { const mo = _MN[m[1].toLowerCase().slice(0, 3)]; if (mo != null) return iso(+m[3], mo, +m[2]); }
  // D/M (no year) → current year
  m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})$/);                    if (m) return iso(yr, +m[2] - 1, +m[1]);
  // D Mon (no year) → current year
  m = s.match(/^(\d{1,2})\s+([A-Za-z]+)$/);
  if (m) { const mo = _MN[m[2].toLowerCase().slice(0, 3)]; if (mo != null) return iso(yr, mo, +m[1]); }
  return null;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const topic = req.headers['x-shopify-topic'] || '';
  const order = req.body;

  if (!order || !order.id) return res.status(400).json({ error: 'No order data' });

  if (!SB_URL || !SB_KEY) {
    console.error('Missing Supabase env vars');
    return res.status(500).json({ error: 'Add SUPABASE_URL and SUPABASE_SERVICE_KEY to Vercel env vars' });
  }

  const sb = createClient(SB_URL, SB_KEY);

  // Customer-topic webhooks (customers/create, customers/update, customers/delete)
  // carry a Shopify CUSTOMER object, not an order. This is the Shopify→BloomFlow half
  // of two-way customer sync: route them to the CRM handler and return before any of
  // the order logic below (which would otherwise misread a customer id as an order id).
  if (topic.startsWith('customers/')) {
    return await handleCustomerWebhook(res, req.body, sb, topic);
  }

  // Order cancelled in Shopify (orders/cancelled, or an update carrying cancelled_at):
  // it shouldn't live in BloomFlow, so remove it and stop here.
  if (topic === 'orders/cancelled' || order.cancelled_at) {
    await sb.from('orders').delete().eq('id', String(order.id));
    console.log(`[Webhook] ${order.name} cancelled → removed from BloomFlow`);
    return res.status(200).json({ ok: true, cancelled: true, order: order.name });
  }

  const attrs   = order.note_attributes || [];
  const getAttr = k => attrs.find(a => a.name?.toLowerCase() === k.toLowerCase())?.value || '';

  const dueDate = getAttr('Order Due Date') ||
                  getAttr('Translated Order Due Date') ||
                  getAttr('Delivery Date') ||
                  getAttr('Delivery Day') ||
                  getAttr('Due Date') || null;

  const dueTime = getAttr('Order Due Time') ||
                  getAttr('Translated Order Due Time') ||
                  getAttr('Delivery Time') || null;

  // Parse the free-text due_date into a real ISO date for the `due_on` column, so
  // BloomFlow can window/filter orders server-side by date (mirrors pd() in flori.html).
  // Without this, date filters on due_date are lexical string compares and over-fetch.
  const due_on = parseDueOn(dueDate);

  const typeRaw = (getAttr('Order Fulfillment Type') || getAttr('Type Of Order') || '').toLowerCase();
  const type    = /pick|collect|store pick/.test(typeRaw) ? 'pickup' : 'delivery';
  const fulfilled = order.fulfillment_status === 'fulfilled';

  const lineItems = (order.line_items || []).map(i => ({
    title:    i.title,
    quantity: i.quantity,
    price:    i.price,
    currency: order.currency || 'MYR',
    image:    i.image?.src || null,
  }));

  const customer = [
    order.customer?.first_name || '',
    order.customer?.last_name  || '',
  ].filter(Boolean).join(' ') || 'Guest';

  // A Shopify "order updated" webhook fires for many reasons (fulfilment, notes,
  // tags…). A blind upsert would wipe state the app owns — the per-product and
  // whole-order "ready" flags, locally deleted line items, designer/priority/notes
  // and manual fields — none of which Shopify knows about. So merge into the row
  // that's already there instead of overwriting it.
  const [{ data: existing }, { data: rmRow }, { data: delRow }] = await Promise.all([
    sb.from('orders').select('*').eq('id', String(order.id)).maybeSingle(),
    sb.from('settings').select('value').eq('key', 'removed_items').maybeSingle(),
    sb.from('settings').select('value').eq('key', 'deleted_orders').maybeSingle(),
  ]);

  // Respect order-delete tombstones: if the user deleted this order in BloomFlow it
  // may still be OPEN in Shopify and keep firing update webhooks — don't resurrect it.
  const deleted = new Set((delRow && Array.isArray(delRow.value) ? delRow.value : []).map(String));
  if (deleted.has(String(order.id))) {
    console.log(`[Webhook] ${order.name} is delete-tombstoned — skipping upsert`);
    return res.status(200).json({ ok: true, skipped: 'deleted', order: order.name });
  }

  // Respect the user's line-item delete tombstones (shared settings store) so a
  // Shopify update can't resurrect a product they removed in the app.
  const removedMap = (rmRow && rmRow.value) || {};
  const removed    = new Set(removedMap[String(order.id)] || []);

  // Line items are app-managed once the order exists: the user may have edited
  // product names/prices/quantities, added photos, marked items ready, or deleted
  // some — Shopify knows none of it. So on UPDATE keep the stored line items
  // wholesale; only build from Shopify's payload on FIRST insert (new order).
  const mergedLineItems = (existing && Array.isArray(existing.line_items) && existing.line_items.length)
    ? existing.line_items
    : lineItems.filter(i => !removed.has(i.title));

  const row = {
    // Canonical order id = bare numeric (Shopify REST id). The GraphQL sync in
    // flori.html (syncOrders → shopId) normalizes its gids to this same shape so
    // the webhook and manual sync never create duplicate rows for one order.
    id:          String(order.id),
    name:        order.name,
    src:         'shopify',
    customer,
    product:     mergedLineItems.map(i => i.title).join(', '),
    line_items:  mergedLineItems,
    // Cover photo is app-managed (Shopify doesn't know about uploaded photos), so
    // preserve the existing row's image on update; only derive one on first insert.
    image:       existing ? (existing.image || null) : (mergedLineItems.find(i => i.image)?.image || null),
    total:       order.current_total_price || order.total_price || null,
    currency:    order.currency || 'MYR',
    due_date:    dueDate,
    due_on,
    due_time:    dueTime,
    type,
    fulfilled,
    // Shopify-sourced fields above are refreshed; app-managed fields below are
    // preserved from the existing row (defaults only on first insert).
    ready:         existing ? existing.ready         : false,
    created_at:    order.created_at || null,
    manual_addr:   existing ? existing.manual_addr   : null,
    recipe:        existing ? existing.recipe        : [],
    designer:      existing ? existing.designer      : null,
    priority:      existing ? existing.priority      : 'normal',
    internal_note: existing ? existing.internal_note : null,
    manual_price:  existing ? existing.manual_price  : null,
    updated_at:  new Date().toISOString(),
  };

  const { error } = await sb.from('orders').upsert(row, { onConflict: 'id' });

  if (error) {
    console.error('Supabase error:', error.message);
    return res.status(500).json({ error: error.message });
  }

  // CRM: keep the customers table in sync (keyed on Shopify customer id). Best-effort
  // — a CRM failure must never fail the order webhook.
  await handleCustomerSync(sb, order);

  // If this order came from a BloomFlow follow-up draft, mark that follow-up
  // "Completed" now that it's a real order. The follow-up id rides as a hidden
  // line-item property (_bloomflow_followup); older drafts carried it as a tag,
  // so fall back to that.
  try {
    let fuId = null;
    for (const li of (order.line_items || [])) {
      const p = (li.properties || []).find(x => x && x.name === '_bloomflow_followup');
      if (p && p.value) { fuId = String(p.value).trim(); break; }
    }
    if (!fuId) {
      const tags = String(order.tags || '').split(',').map(t => t.trim());
      if (tags.includes('bloomflow-followup')) fuId = tags.find(t => /^fu-/.test(t)) || null;
    }
    if (fuId) {
      // Also stamp the created order's number so it auto-shows on the completed
      // follow-up (no manual entry needed for orders exported from BloomFlow).
      const { error: fuErr } = await sb.from('followups').update({ status: 'completed', order_no: order.name || null }).eq('id', fuId);
      if (fuErr) console.error('Follow-up complete error:', fuErr.message);
      else console.log(`[Webhook] follow-up ${fuId} → completed (${order.name})`);
    }
  } catch (e) { console.error('Follow-up tag check failed:', e.message); }

  console.log(`[Webhook] ${topic} → ${order.name} saved`);
  return res.status(200).json({ ok: true, order: order.name });
}

// Collect an email onto a customer's email list (customers.emails text[]), keyed by
// Shopify customer id, keeping the primary + all previously seen, de-duped.
// Best-effort: no-ops if the emails column isn't there yet (SQL not run).
async function collectEmail(sb, sid, newEmail){
  if (!newEmail) return;
  try {
    const { data } = await sb.from('customers').select('email, emails').eq('shopify_customer_id', sid).maybeSingle();
    const seen=new Set(), out=[];
    [...(data&&data.email?[data.email]:[]), ...(data&&Array.isArray(data.emails)?data.emails:[]), newEmail]
      .forEach(e=>{ e=(e||'').trim(); if(e){ const k=e.toLowerCase(); if(!seen.has(k)){ seen.add(k); out.push(e); } } });
    await sb.from('customers').update({ emails: out }).eq('shopify_customer_id', sid);
  } catch (e) { console.error('email collect (emails column?):', e.message); }
}

// CRM customer sync — upsert the customers table keyed on the Shopify customer id
// (the stable identity). Phone is just an attribute (the customer's OWN phone, never
// a recipient/shipping number). Preserves CRM-owned fields (tag, birthday, prefs,
// notes) by only writing Shopify-sourced columns; first_order_at is set once.
async function handleCustomerSync(sb, order) {
  try {
    const c = order.customer;
    if (!c || c.id == null) return;                   // need the Shopify customer id (our key)
    const sid = String(c.id);
    const phone = c.phone || order.billing_address?.phone || null;   // own/sender phone, not recipient

    const { data: existing } = await sb.from('customers')
      .select('id, first_order_at, order_source').eq('shopify_customer_id', sid).maybeSingle();

    const row = {
      shopify_customer_id: sid,
      name: `${c.first_name || ''} ${c.last_name || ''}`.trim() || null,
      email: c.email || order.email || null,
      last_order_at: order.created_at || new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    if (phone)                   row.phone = phone;   // never overwrite a phone with null
    if (c.orders_count != null)  row.total_orders = c.orders_count;
    if (c.total_spent != null)   row.total_spend  = parseFloat(c.total_spent) || 0;
    if (!existing || !existing.first_order_at) row.first_order_at = order.created_at || new Date().toISOString();
    // Platform: online store vs draft order; 'mixed' if the customer has used both.
    const thisSrc = /draft/i.test(order.source_name || '') ? 'draft' : 'online';
    row.order_source = (existing && existing.order_source && existing.order_source !== thisSrc) ? 'mixed' : thisSrc;

    const { error } = await sb.from('customers').upsert(row, { onConflict: 'shopify_customer_id' });
    if (error) console.error('CRM customer sync error:', error.message);
    await collectEmail(sb, sid, c.email || order.email);   // keep every email this customer has used
  } catch (e) {
    console.error('handleCustomerSync failed:', e.message);
  }
}

// Two-way customer sync, Shopify→BloomFlow. Fired by the customers/create,
// customers/update and customers/delete webhooks; the body is a Shopify CUSTOMER
// object (not an order). We mirror only Shopify-OWNED fields into the customers
// table keyed on shopify_customer_id. CRM-owned columns (tag, source, order_source,
// birthday, anniversary, notes, preferences) are simply NOT written here, and a
// PostgREST upsert only updates the columns present in the row — so those values are
// preserved on conflict and there is no clobber loop with the BloomFlow→Shopify
// write-back (pushCustomerToShopify). Always returns 200 so Shopify won't hammer
// retries on a transient CRM error; the error is logged for us instead.
async function handleCustomerWebhook(res, c, sb, topic) {
  try {
    if (!c || c.id == null) return res.status(200).json({ ok: true, skipped: 'no customer id' });
    const sid = String(c.id);

    // Deletion: drop the row so the customer disappears from BloomFlow live.
    if (topic === 'customers/delete') {
      const { error } = await sb.from('customers').delete().eq('shopify_customer_id', sid);
      if (error) console.error('Customer webhook delete error:', error.message);
      console.log(`[Webhook] ${topic} → customer ${sid} removed from BloomFlow`);
      return res.status(200).json({ ok: true, deleted: sid });
    }

    const ad = c.default_address || (Array.isArray(c.addresses) ? c.addresses[0] : null) || {};
    // The customer's OWN phone. On a customer webhook default_address is the
    // customer's own saved address (not a gift recipient), so its phone is a safe
    // fallback for the contact number.
    const phone = c.phone || c.default_phone_number || ad.phone || null;

    const row = {
      shopify_customer_id: sid,
      updated_at: new Date().toISOString(),
    };
    // Only write fields Shopify actually provides, so a sparse webhook payload can
    // never null out a value BloomFlow already has (name/email/phone/address).
    const nm = `${c.first_name || ''} ${c.last_name || ''}`.trim();
    if (nm)                      row.name         = nm;
    if (c.email)                 row.email        = c.email;
    if (phone)                   row.phone        = phone;
    if (c.orders_count != null)  row.total_orders = c.orders_count;
    if (c.total_spent != null)   row.total_spend  = parseFloat(c.total_spent) || 0;
    if (ad.address1)             row.address1     = ad.address1;
    if (ad.address2)             row.address2     = ad.address2;
    if (ad.city)                 row.city         = ad.city;
    if (ad.province)             row.state        = ad.province;
    if (ad.zip)                  row.zip          = ad.zip;
    if (ad.country)              row.country      = ad.country;

    const { error } = await sb.from('customers').upsert(row, { onConflict: 'shopify_customer_id' });
    if (error) {
      console.error('Customer webhook upsert error:', error.message);
      return res.status(200).json({ ok: false, error: error.message });
    }
    await collectEmail(sb, sid, c.email);                  // keep every email this customer has used
    console.log(`[Webhook] ${topic} → customer ${sid} (${row.name || 'no name'}) synced`);
    return res.status(200).json({ ok: true, customer: sid });
  } catch (e) {
    console.error('handleCustomerWebhook failed:', e.message);
    return res.status(200).json({ ok: true, error: e.message });
  }
}
