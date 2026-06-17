// POST /api/webhook
// Receives Shopify order webhooks and saves to Supabase

import { createClient } from '@supabase/supabase-js';

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;

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

  // CRM: keep the customers table in sync (merge on phone). Best-effort — a CRM
  // failure must never fail the order webhook.
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

// CRM customer sync — upsert the customers table on phone (the single merge key).
// Preserves CRM-owned fields (tag, birthday, anniversary, source, notes, prefs)
// by only writing the Shopify-sourced columns. first_order_at is set once.
async function handleCustomerSync(sb, order) {
  try {
    const c = order.customer;
    if (!c) return;                                   // guest checkout — nothing to merge
    // Customer's OWN phone (or billing = sender). NEVER the shipping/default address
    // phone — that's usually the recipient on a gift order and would merge the wrong
    // people together.
    const phone = c.phone || order.billing_address?.phone || null;
    if (!phone) return;                               // no phone = handled by import, not here

    const { data: existing } = await sb.from('customers')
      .select('id, first_order_at, order_source').eq('phone', phone).maybeSingle();

    const row = {
      phone,
      name: `${c.first_name || ''} ${c.last_name || ''}`.trim() || null,
      email: c.email || order.email || null,
      last_order_at: order.created_at || new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    if (c.id != null)            row.shopify_customer_id = String(c.id);
    if (c.orders_count != null)  row.total_orders = c.orders_count;
    if (c.total_spent != null)   row.total_spend  = parseFloat(c.total_spent) || 0;
    // Stamp the first order date only when we don't already have one.
    if (!existing || !existing.first_order_at) row.first_order_at = order.created_at || new Date().toISOString();
    // Platform: online store vs draft order. If the customer has ordered via both
    // over time, mark them 'mixed'.
    const thisSrc = /draft/i.test(order.source_name || '') ? 'draft' : 'online';
    row.order_source = (existing && existing.order_source && existing.order_source !== thisSrc) ? 'mixed' : thisSrc;

    const { error } = await sb.from('customers').upsert(row, { onConflict: 'phone' });
    if (error) console.error('CRM customer sync error:', error.message);
    else console.log(`[Webhook] CRM customer synced (${phone})`);
  } catch (e) {
    console.error('handleCustomerSync failed:', e.message);
  }
}
