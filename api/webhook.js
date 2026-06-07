// POST /api/webhook
// Receives Shopify order webhooks and saves to Supabase
// Topics handled: orders/create, orders/updated, orders/fulfilled

import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';

// ── Config — set these in Vercel environment variables ──
const SB_URL       = process.env.SUPABASE_URL;
const SB_KEY       = process.env.SUPABASE_SERVICE_KEY; // use service key server-side
const WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET; // from Shopify webhook settings

export default async function handler(req, res) {
  // Only accept POST
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  // ── Verify Shopify webhook signature ──
  if (WEBHOOK_SECRET) {
    const hmac   = req.headers['x-shopify-hmac-sha256'];
    const body   = JSON.stringify(req.body);
    const digest = crypto
      .createHmac('sha256', WEBHOOK_SECRET)
      .update(body, 'utf8')
      .digest('base64');
    if (digest !== hmac) {
      console.error('Webhook signature mismatch');
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  const topic = req.headers['x-shopify-topic'] || '';
  const order = req.body;

  if (!order || !order.id) return res.status(400).json({ error: 'No order data' });

  // ── Init Supabase ──
  if (!SB_URL || !SB_KEY) {
    console.error('Missing Supabase env vars');
    return res.status(500).json({ error: 'Server misconfigured' });
  }
  const sb = createClient(SB_URL, SB_KEY);

  // ── Parse the Shopify order into our schema ──
  const attrs      = order.note_attributes || [];
  const getAttr    = k => attrs.find(a => a.name?.toLowerCase() === k.toLowerCase())?.value || '';

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

  const row = {
    id:          String(order.id),
    name:        order.name,
    src:         'shopify',
    customer,
    product:     lineItems.map(i => i.title).join(', '),
    line_items:  lineItems,
    image:       lineItems[0]?.image || null,
    total:       order.current_total_price || order.total_price || null,
    currency:    order.currency || 'MYR',
    due_date:    dueDate,
    due_time:    dueTime,
    type,
    fulfilled,
    created_at:  order.created_at || null,
    manual_addr: null,
    recipe:      [],
    updated_at:  new Date().toISOString(),
  };

  // ── Upsert into Supabase (insert or update) ──
  const { error } = await sb.from('orders').upsert(row, { onConflict: 'id' });

  if (error) {
    console.error('Supabase upsert error:', error.message);
    return res.status(500).json({ error: error.message });
  }

  console.log(`[Webhook] ${topic} → ${order.name} saved to Supabase`);
  return res.status(200).json({ ok: true, order: order.name, topic });
}
