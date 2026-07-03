// GET /api/notify-test?secret=...&to=0164129499&template=both
// Manual test harness for the WhatsApp notify module — sends the approved templates to a
// given number so you can eyeball them before going live. NOT part of the live flow.
// Guarded by NOTIFY_TEST_SECRET so it can't be abused. Safe to delete after testing.
//
// Uses the same env + helpers as api/notify.js (WHATSAPP_PHONE_NUMBER_ID/ACCESS_TOKEN).
// Templates: out_for_delivery_bg, delivered_with_photo, delivered_no_photo_bg.

import { toE164MY, buildTemplate, sampleOrderStatusUrl, statusUrlSuffix } from './notify.js';

const WA_PHONE_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const WA_TOKEN    = process.env.WHATSAPP_ACCESS_TOKEN;
const GRAPH_VER   = 'v21.0';

// A public, direct https image just for the photo-template test (Meta needs a reachable
// image URL). Override with &photo=<url>.
const SAMPLE_PHOTO = 'https://images.unsplash.com/photo-1490750967868-88aa4486c946?w=900&q=80&fm=jpg';

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
  if (!WA_PHONE_ID || !WA_TOKEN) return res.status(500).json({ error: 'WhatsApp env missing' });

  // Sample mode: show a real order's status URL so we can shape the URL-button base.
  if (q.sampleorder) {
    try { return res.status(200).json({ order: await sampleOrderStatusUrl() }); }
    catch (e) { return res.status(200).json({ error: e.message }); }
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
