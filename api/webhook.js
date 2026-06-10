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
  const [{ data: existing }, { data: rmRow }] = await Promise.all([
    sb.from('orders').select('*').eq('id', String(order.id)).maybeSingle(),
    sb.from('settings').select('value').eq('key', 'removed_items').maybeSingle(),
  ]);

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

  console.log(`[Webhook] ${topic} → ${order.name} saved`);
  return res.status(200).json({ ok: true, order: order.name });
}
