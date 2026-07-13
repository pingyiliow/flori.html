// Theme-matched HTML email builders for the delivery notifications that api/notify.js sends
// via Resend. Ported from the user's Shopify Liquid templates (Order Delivered / Out for
// Delivery), with the care-tips engine intact. Palette + fonts mirror the LIVE storefront
// theme (bamboo-theme/config/settings_data.json): cream #F6F3EB background, deep burgundy
// #380213 buttons/accents, brown #423721 ink, taupe borders, Instrument Serif headings + Jost
// body — with Georgia/system fallbacks for clients that block web fonts.
//
// NOT a Vercel route: the leading underscore makes Vercel treat this as a support module, not
// a serverless function.
//
// Data comes from the Shopify REST order (fetched in notify.js): line_items (title/quantity/
// price/product_type), shipping_address, note_attributes (order.attributes equivalent),
// created_at, total_price, currency, order_status_url. Emails go to the BUYER only; showing the
// recipient's delivery details to the buyer is their own order info (safe).

// Bamboo GREEN scheme (user chose green over the theme's burgundy, 2026-07-13) — matches the
// original Liquid templates: forest green #1a3d2b buttons/accents, sage #8fbe9f, cream ground.
const C = {
  bg: '#f5f0eb', panel: '#ffffff', card: '#f9f5ef', border: '#e8e0d8', borderSoft: '#ede8e1',
  ink: '#3a3028', body: '#5a5048', muted: '#9a8e84', faint: '#a89e94', pale: '#c8bfb0',
  brand: '#1a3d2b', brandText: '#f5f0eb', brandSoft: '#8fbe9f', brandSubtle: '#8fbe9f',
  pill: '#d4ead9', pillInk: '#1a3d2b', accent2: '#5a8f6e', line: '#2d6045',
  urgent: '#c8722a', urgentBg: '#fff8f0', urgentInk: '#a85e1a',
};
const FONT_HEAD = "'Instrument Serif', Georgia, 'Times New Roman', serif";
const FONT_BODY = "'Jost', -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif";
const FONTS_IMPORT = "@import url('https://fonts.googleapis.com/css2?family=Instrument+Serif&family=Jost:wght@400;500;600&display=swap');";
const LOGO = 'https://bambooflorist.com.my/cdn/shop/files/FA_bamboo_green_florist-02.png';
const SIDES = `border-left:1px solid ${C.border};border-right:1px solid ${C.border};`;

function esc(s) {
  return String(s == null ? '' : s).replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
}
function money(v, cur) {
  const n = Number(v);
  if (!isFinite(n)) return esc(v);
  const sym = cur === 'MYR' || !cur ? 'RM ' : cur + ' ';
  return sym + n.toFixed(2);
}
function fmtDateTime(iso) {
  try {
    return new Date(iso).toLocaleString('en-GB', { timeZone: 'Asia/Kuala_Lumpur', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true });
  } catch { return ''; }
}
function fmtDate(iso) {
  try {
    return new Date(iso).toLocaleDateString('en-GB', { timeZone: 'Asia/Kuala_Lumpur', day: '2-digit', month: 'short', year: 'numeric' });
  } catch { return ''; }
}
function attr(order, name) {
  const a = ((order && order.note_attributes) || []).find(x => x && String(x.name).toLowerCase() === String(name).toLowerCase());
  return a && a.value != null ? String(a.value) : '';
}
// A deliberately ROUGH delivery time from the EasyRoutes event timestamp: rounded to the
// nearest 15 minutes with an "around" prefix, so a late driver tap doesn't read as an exact
// claim. Returns '' if the timestamp is missing/unparseable (caller falls back to the window).
function roughTime(iso) {
  if (!iso) return '';
  try {
    const ms = 15 * 60 * 1000;
    const r = new Date(Math.round(new Date(iso).getTime() / ms) * ms);
    return 'around ' + r.toLocaleTimeString('en-US', { timeZone: 'Asia/Kuala_Lumpur', hour: 'numeric', minute: '2-digit', hour12: true });
  } catch { return ''; }
}
function firstName(order) {
  const c = (order && order.customer) || {};
  return String(c.first_name || '').trim();
}
function addressBlock(order) {
  const s = (order && order.shipping_address) || {};
  const l2 = s.address2 ? ', ' + esc(s.address2) : '';
  const line1 = esc(s.address1 || '');
  const line2 = `${esc(s.zip || '')} ${esc(s.city || '')}${s.province ? ', ' + esc(s.province) : ''}`.trim();
  if (!line1 && !line2) return '—';
  return `${line1}${l2}${line1 ? ',<br/>' : ''}${line2}`;
}

function styleBlock() {
  return `${FONTS_IMPORT}
    body{margin:0;padding:0;background:${C.bg};font-family:${FONT_BODY};-webkit-font-smoothing:antialiased;}
    table{border-collapse:collapse;mso-table-lspace:0;mso-table-rspace:0;} img{border:0;display:block;outline:none;-ms-interpolation-mode:bicubic;}
    *{box-sizing:border-box;} a{text-decoration:none;} .h{font-family:${FONT_HEAD};}
    .care-section-label{font-size:12px;letter-spacing:1.5px;text-transform:uppercase;color:${C.faint};margin:0 0 4px;font-weight:500;}
    .care-intro{font-size:14px;color:${C.muted};margin:0 0 20px;line-height:1.7;}
    .care-card{background:${C.card};border-radius:4px;padding:16px 18px;margin-bottom:10px;}
    .care-card-brand-top{border-top:2px solid ${C.brand};}
    .care-card-muted-top{border-top:2px solid ${C.pale};}
    .care-card-brand-left{border-left:3px solid ${C.brand};}
    .care-card-accent-left{border-left:3px solid ${C.accent2};}
    .care-card-urgent{background:${C.urgentBg};border-left:3px solid ${C.urgent};}
    .care-title{font-size:14px;font-weight:600;color:${C.ink};margin:0 0 6px;}
    .care-title-brand{font-size:14px;font-weight:600;color:${C.brand};margin:0 0 6px;}
    .care-title-urgent{font-size:14px;font-weight:600;color:${C.urgentInk};margin:0 0 6px;}
    .care-body{font-size:13px;color:${C.body};margin:0;line-height:1.7;}
    .expect-card{background:${C.card};border-radius:4px;padding:16px 18px;margin-bottom:10px;}
    .expect-card-brand{border-top:2px solid ${C.brand};}
    .expect-card-muted{border-top:2px solid ${C.pale};}
    .expect-title{font-size:14px;font-weight:600;color:${C.ink};margin:0 0 5px;}
    .expect-body{font-size:13px;color:${C.body};margin:0;line-height:1.7;}
    .spine-table{width:100%;border-collapse:collapse;}
    @media only screen and (max-width:620px){
      .wrapper{width:100%!important;} .panel-pad{padding-left:20px!important;padding-right:20px!important;}
      .two-col-td{display:block!important;width:100%!important;padding-bottom:12px!important;} .logo-img{width:160px!important;}
    }`;
}

function footer() {
  return `<tr><td style="background:${C.brand};border-radius:0 0 4px 4px;">
    <div class="panel-pad" style="padding:26px 40px;text-align:center;">
      <div style="margin-bottom:14px;">
        <a href="https://www.instagram.com/bambooflorist/" style="color:${C.brandSoft};font-size:13px;margin:0 10px;">Instagram</a>
        <span style="color:${C.line};font-size:13px;">·</span>
        <a href="https://www.facebook.com/bamboogreenflorist" style="color:${C.brandSoft};font-size:13px;margin:0 10px;">Facebook</a>
        <span style="color:${C.line};font-size:13px;">·</span>
        <a href="https://bambooflorist.com.my" style="color:${C.brandSoft};font-size:13px;margin:0 10px;">bambooflorist.com.my</a>
      </div>
      <p style="margin:0;font-size:12px;color:${C.brandSoft};line-height:1.7;opacity:.85;">© Bamboo Green Florist · Bukit Mertajam, Penang</p>
    </div></td></tr>`;
}

function shell(innerRows) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<style>${styleBlock()}</style></head><body>
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.bg};"><tr>
<td align="center" valign="top" style="padding:32px 10px;">
<table class="wrapper" width="560" cellpadding="0" cellspacing="0" border="0" style="width:560px;max-width:560px;">
  <tr><td style="background:${C.panel};padding:32px 40px 28px;text-align:center;border-bottom:1px solid ${C.border};border-radius:4px 4px 0 0;">
    <img class="logo-img" src="${LOGO}" alt="Bamboo Green Florist" width="200" style="width:200px;height:auto;margin:0 auto;"/>
  </td></tr>
  ${innerRows}
  ${footer()}
</table></td></tr></table></body></html>`;
}

// one filled + connector spine step (completed look)
function spineDone(label, sub, isTitle) {
  const top = isTitle
    ? `<p style="font-size:15px;font-weight:500;color:${C.brand};margin:0 0 4px;">${esc(label)}</p>`
    : `<p style="font-size:12px;letter-spacing:1.5px;text-transform:uppercase;color:${C.brand};margin:0 0 4px;font-weight:500;">${esc(label)}</p>`;
  return `<table class="spine-table" cellpadding="0" cellspacing="0" border="0"><tr>
    <td width="48" valign="top" style="width:48px;"><table cellpadding="0" cellspacing="0" border="0" style="width:48px;">
      <tr><td align="center" style="padding-top:4px;padding-bottom:6px;"><div style="width:13px;height:13px;border-radius:50%;background:${C.brand};margin:0 auto;"></div></td></tr>
      <tr><td align="center"><div style="width:2px;background:${C.brand};min-height:32px;margin:0 auto;"></div></td></tr>
    </table></td>
    <td valign="top" style="padding-left:18px;padding-bottom:28px;padding-top:4px;">${top}
      <p style="font-size:14px;color:${C.muted};margin:0;">${sub}</p></td></tr></table>`;
}

/* ─────────────── DELIVERED ─────────────── */

const CARE = [
  { key: 'bouquet', match: t => t.includes('hand bouquet'), label: 'Hand bouquet care',
    intro: "Your bouquet stems are wrapped with wet cotton to keep flowers hydrated during delivery. Here's what to do when it arrives.",
    cards: [
      { cls: 'care-card-brand-left', tCls: 'care-title-brand', t: 'Option 1 — Unwrap & place in a vase', b: 'Gently remove the outer wrapping and peel away the wet cotton from the stems. Trim the stem ends at a diagonal, then place into a clean vase with fresh water. This is the best way to keep your flowers lasting as long as possible.' },
      { cls: 'care-card-accent-left', tCls: 'care-title-brand', t: 'Option 2 — Keep the wrapping on', b: 'Leave it wrapped to enjoy the full presentation. The wet cotton keeps stems hydrated. Check daily — if the cotton feels dry, add a little water to keep it moist.' },
      { cls: 'care-card-muted-top', tCls: 'care-title', t: 'Keep away from aircond vents', b: 'Cold dry aircon air dries out petals quickly. A cool indoor spot is ideal — just not directly under the aircond unit.' },
      { cls: 'care-card-muted-top', tCls: 'care-title', t: 'Bright room, no direct sun', b: 'Keep indoors in a bright spot away from direct afternoon sunlight. Malaysian sun through glass will wilt blooms within hours.' },
    ] },
  { key: 'vase', match: t => t.includes('vase'), label: 'Vase arrangement care',
    intro: 'A little daily care goes a long way. Follow these steps to keep your blooms looking their best.',
    cards: [
      { cls: 'care-card-brand-top', tCls: 'care-title', t: 'Change the water daily', b: "In Malaysia's heat, water turns cloudy fast. Rinse the vase and refill with fresh water every day — this is the single biggest thing you can do to extend their life." },
      { cls: 'care-card-brand-top', tCls: 'care-title', t: 'Trim the stems every 2 days', b: 'Cut about 1–2 cm at a diagonal with clean scissors. This opens up the stem so flowers can drink properly. Do this each time you change the water.' },
      { cls: 'care-card-muted-top', tCls: 'care-title', t: 'Keep away from aircond vents', b: 'Cold dry air from aircond dries out petals quickly. Place in a cool spot, not directly under the aircond unit.' },
      { cls: 'care-card-muted-top', tCls: 'care-title', t: 'Bright room, no direct sun', b: 'A bright indoor spot is ideal. Direct afternoon sun through glass in Malaysian heat will wilt blooms within hours.' },
    ] },
  { key: 'basket', match: t => t.includes('flower basket'), label: 'Flower basket care',
    intro: "Your flower basket is arranged in floral foam that holds water to keep the blooms fresh. Here's how to keep it looking beautiful.",
    cards: [
      { cls: 'care-card-brand-top', tCls: 'care-title', t: 'Top up the foam daily', b: "Pour a small amount of water directly into the floral foam every day to keep it moist. Don't let the foam dry out completely — once it dries it cannot fully re-absorb water and the flowers will decline quickly." },
      { cls: 'care-card-brand-top', tCls: 'care-title', t: 'Check the weight', b: 'Lift the basket gently — if it feels very light, the foam needs water. Add water slowly so it absorbs without overflowing the basket base.' },
      { cls: 'care-card-muted-top', tCls: 'care-title', t: 'Keep away from aircond vents', b: 'Cold dry aircon air speeds up water loss in the foam. A cool indoor spot works well — just not directly under the unit.' },
      { cls: 'care-card-muted-top', tCls: 'care-title', t: 'Bright room, no direct sun', b: 'Keep in a bright indoor spot away from direct afternoon sunlight. Malaysian sun through glass dries out both foam and petals very quickly.' },
    ] },
  { key: 'orchid', match: t => t.includes('orchid'), label: 'Orchid care guide',
    intro: "Good news — orchids love Malaysia's warm, humid climate. With the right care they can bloom for weeks and rebloom season after season.",
    cards: [
      { cls: 'care-card-brand-top', tCls: 'care-title', t: 'Water once a week', b: "Water thoroughly once a week, then let the roots dry out before the next watering. In Malaysia's humidity you rarely need more than this. When in doubt, wait another day — overwatering is the number one reason orchids decline." },
      { cls: 'care-card-brand-top', tCls: 'care-title', t: 'Bright indirect light', b: 'Near a bright window is ideal, but keep out of direct sun. Leaves should be bright green — yellow means too much light, very dark green means too little.' },
      { cls: 'care-card-muted-top', tCls: 'care-title', t: 'Good airflow, not cold air', b: 'Orchids love gentle air movement — it prevents fungal issues in our humid weather. A fan on low nearby works great. Avoid placing directly under the aircond as cold dry air stresses the plant.' },
      { cls: 'care-card-muted-top', tCls: 'care-title', t: 'After the blooms drop', b: 'Cut the flower spike just above the second node from the base. Keep watering as usual — the plant can produce a new spike and rebloom within a few months.' },
      { cls: 'care-card-brand-left', tCls: 'care-title-brand', t: 'Watch the roots', b: 'Healthy roots are firm and silvery-green. Soft or brown roots mean overwatering. Make sure your pot has drainage holes and never let the plant sit in standing water — root rot is the main risk in Malaysia’s humidity.' },
    ] },
  { key: 'cake', match: t => t.includes('cake'), label: 'Cake reminder', urgent: true,
    intro: 'A quick note to keep your cake at its best.',
    cards: [
      { cls: 'care-card-urgent', tCls: 'care-title-urgent', t: 'Refrigerate immediately', b: "Fresh cream cakes must go into the refrigerator as soon as possible after delivery. In Malaysia's heat, cream can soften and spoil within 1–2 hours at room temperature. Please do not leave it out." },
      { cls: 'care-card-brand-top', tCls: 'care-title', t: 'Best consumed within 2 days', b: 'For the best taste and texture, enjoy within 2 days of delivery. Keep it covered or in the box inside the fridge to prevent it from absorbing other odours.' },
      { cls: 'care-card-muted-top', tCls: 'care-title', t: 'Before serving', b: 'Remove from the fridge and let it sit at room temperature for about 15–20 minutes before serving. This brings the cream back to its best texture and makes cutting much easier.' },
    ] },
  { key: 'fruit', match: t => t.includes('fruit basket'), label: 'Fruit basket reminder', urgent: true,
    intro: 'Fresh fruit is best enjoyed soon. A few simple tips to keep everything at its best.',
    cards: [
      { cls: 'care-card-urgent', tCls: 'care-title-urgent', t: 'Refrigerate to keep fresh', b: "In Malaysia's heat, fresh fruits deteriorate quickly at room temperature. Transfer to the refrigerator soon after delivery — especially cut fruits, berries, and grapes." },
      { cls: 'care-card-brand-top', tCls: 'care-title', t: 'Best enjoyed within 2–3 days', b: 'Whole fruits like oranges and apples keep longer, while softer fruits like strawberries and grapes are best eaten within the first day or two.' },
      { cls: 'care-card-muted-top', tCls: 'care-title', t: 'Wash before eating', b: 'Rinse all fruits under clean running water before consuming. For berries, only wash right before eating — washing too early causes them to soften faster.' },
    ] },
  { key: 'artificial', match: t => t.includes('artificial'), label: 'Care tips',
    intro: 'Your artificial arrangement is designed to last — no water needed, no wilting. Just a little occasional care keeps it looking beautiful long-term.',
    cards: [
      { cls: 'care-card-brand-top', tCls: 'care-title', t: 'Keep away from direct sunlight', b: 'Prolonged exposure to direct sun will fade the colours over time — especially in Malaysia where UV is intense year-round. A bright indoor spot out of direct sunlight keeps colours vibrant for longer.' },
      { cls: 'care-card-brand-top', tCls: 'care-title', t: 'Dust gently every few weeks', b: 'Use a soft dry cloth or a feather duster to remove dust from the petals and leaves. A hairdryer on the cool setting also works well for getting into tight spots.' },
      { cls: 'care-card-muted-top', tCls: 'care-title', t: 'No water needed', b: 'Artificial arrangements do not require watering. If your arrangement came in a decorative vase with stones or a base, leave it as-is — adding water is unnecessary and may damage the base over time.' },
    ] },
];

function careSection(order) {
  const types = ((order && order.line_items) || []).map(li => String((li && li.product_type) || '').toLowerCase());
  const detected = CARE.filter(c => types.some(t => c.match(t)));
  if (!detected.length) return '';
  // urgent (cake/fruit) first, then the rest in defined order
  detected.sort((a, b) => (b.urgent ? 1 : 0) - (a.urgent ? 1 : 0));
  return detected.map(c => {
    const cards = c.cards.map((cd, i) => `<div class="care-card ${cd.cls}"${i === c.cards.length - 1 ? ' style="margin-bottom:0;"' : ''}>
        <p class="${cd.tCls}">${esc(cd.t)}</p><p class="care-body">${esc(cd.b)}</p></div>`).join('');
    return `<tr><td class="panel-pad" style="background:${C.panel};padding:0 40px;${SIDES}">
      <div style="border-top:1px solid ${C.border};padding-top:32px;padding-bottom:32px;">
        <p class="care-section-label">${esc(c.label)}</p><p class="care-intro">${esc(c.intro)}</p>${cards}
      </div></td></tr>`;
  }).join('');
}

function orderSummary(order) {
  const items = ((order && order.line_items) || []).map((li, i, arr) => `<table width="100%" cellpadding="0" cellspacing="0" border="0" style="${i < arr.length - 1 ? `border-bottom:1px solid ${C.borderSoft};` : ''}">
    <tr><td style="font-size:14px;color:${C.ink};padding:8px 0;">${esc(li.title)} <span style="color:${C.faint};">× ${esc(li.quantity)}</span></td>
    <td align="right" width="80" style="font-size:14px;color:${C.ink};font-weight:500;padding:8px 0;white-space:nowrap;">${money(li.price, order.currency)}</td></tr></table>`).join('');
  return `<tr><td class="panel-pad" style="background:${C.panel};padding:0 40px;${SIDES}">
    <div style="border-top:1px solid ${C.border};padding-top:24px;padding-bottom:24px;">
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:14px;"><tr>
        <td><p style="font-size:12px;letter-spacing:1.5px;text-transform:uppercase;color:${C.faint};margin:0;font-weight:500;">${esc(order.name || '')}</p></td>
        <td align="right"><p style="font-size:15px;color:${C.brand};font-weight:600;margin:0;">${money(order.total_price, order.currency)}</p></td>
      </tr></table>${items}
    </div></td></tr>`;
}

export function buildDeliveredEmail(order, opts = {}) {
  const nm = firstName(order);
  const orderNo = (order && order.name) || '';
  const statusUrl = opts.statusUrl || (order && order.order_status_url) || '';
  const photoLink = opts.photoLink || '';
  const dueDate = attr(order, 'Order Due Date') || fmtDate(order && order.created_at);
  const dueTime = attr(order, 'Order Due Time') || '—';
  // "Delivered at" = the rough EasyRoutes event time when available, else the delivery window.
  const deliveredAt = roughTime(opts.deliveredAt) || dueTime;
  const recipient = attr(order, 'recipient_name') || ((order && order.shipping_address && order.shipping_address.name) || '');

  const proofCard = (photoLink || statusUrl) ? `<div style="background:${C.card};border-radius:4px;padding:18px 20px;border-left:3px solid ${C.accent2};margin-top:12px;">
        <p style="font-size:12px;letter-spacing:1.2px;text-transform:uppercase;color:${C.faint};margin:0 0 14px;">Proof of delivery</p>
        ${photoLink ? `<img src="${esc(photoLink)}" alt="Proof of delivery" width="100%" style="width:100%;height:auto;border-radius:4px;display:block;margin-bottom:14px;"/>` : ''}
        ${statusUrl ? `<div style="${photoLink ? `border-top:1px solid ${C.borderSoft};padding-top:14px;` : ''}">
          <a href="${esc(statusUrl)}" style="display:block;background:${C.brand};border-radius:4px;padding:13px 20px;text-align:center;font-size:13px;color:${C.brandText};font-weight:500;letter-spacing:0.5px;text-transform:uppercase;">View delivery record →</a></div>` : ''}
      </div>` : '';

  const inner = `
    <!-- HERO -->
    <tr><td style="background:${C.brand};padding:36px 40px 32px;">
      <p style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:${C.brandSoft};margin:0 0 10px;font-weight:500;">Delivered</p>
      <h1 class="h" style="font-size:28px;color:${C.brandText};margin:0 0 8px;font-weight:400;line-height:1.3;">Your order has arrived${nm ? ', ' + esc(nm) : ''}.</h1>
      <p style="font-size:14px;color:${C.brandSubtle};margin:0;line-height:1.7;">We hope it brings joy to whoever receives it. Thank you for choosing Bamboo Green.</p>
    </td></tr>

    <!-- SPINE -->
    <tr><td class="panel-pad" style="background:${C.panel};padding:32px 40px 24px;${SIDES}">
      ${spineDone('Order received', `${esc(fmtDateTime(order && order.created_at))} &nbsp;·&nbsp; ${esc(orderNo)}`)}
      ${spineDone('Prepared', 'Hand-crafted and ready for delivery', true)}
      ${spineDone('Out for delivery', `${esc(dueDate)} &nbsp;·&nbsp; ${esc(dueTime)}`, true)}
      <table class="spine-table" cellpadding="0" cellspacing="0" border="0"><tr>
        <td width="48" valign="top" style="width:48px;padding-top:2px;"><div style="width:18px;height:18px;border-radius:50%;background:${C.brand};outline:4px solid ${C.pill};outline-offset:2px;margin:0 auto;"></div></td>
        <td valign="top" style="padding-left:18px;padding-bottom:8px;">
          <span style="display:inline-block;background:${C.pill};color:${C.pillInk};font-size:11px;letter-spacing:1.2px;text-transform:uppercase;padding:4px 12px;border-radius:99px;margin-bottom:10px;font-weight:500;">Delivered</span>
          <p style="font-size:15px;font-weight:600;color:${C.brand};margin:0 0 5px;">Order delivered</p>
          <p style="font-size:14px;color:${C.muted};margin:0 0 18px;line-height:1.7;">${esc(dueDate)}</p>
          <div style="background:${C.card};border-radius:4px;padding:18px 20px;border-left:3px solid ${C.brand};">
            <p style="font-size:12px;letter-spacing:1.2px;text-transform:uppercase;color:${C.faint};margin:0 0 14px;">Delivery confirmed</p>
            <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:14px;"><tr>
              <td class="two-col-td" width="50%" valign="top" style="padding-right:10px;">
                <p style="font-size:11px;color:${C.faint};margin:0 0 4px;text-transform:uppercase;letter-spacing:1px;">Recipient</p>
                <p style="font-size:14px;color:${C.ink};font-weight:500;margin:0;">${esc(recipient) || '—'}</p></td>
              <td class="two-col-td" width="50%" valign="top">
                <p style="font-size:11px;color:${C.faint};margin:0 0 4px;text-transform:uppercase;letter-spacing:1px;">Delivered at</p>
                <p style="font-size:14px;color:${C.ink};font-weight:500;margin:0;">${esc(deliveredAt)}</p></td>
            </tr></table>
            <p style="font-size:11px;color:${C.faint};margin:0 0 4px;text-transform:uppercase;letter-spacing:1px;">Address</p>
            <p style="font-size:14px;color:${C.ink};margin:0;line-height:1.6;">${addressBlock(order)}</p>
          </div>
          ${proofCard}
        </td></tr></table>
    </td></tr>

    ${orderSummary(order)}
    ${careSection(order)}

    <!-- CLOSING -->
    <tr><td class="panel-pad" style="background:${C.panel};padding:0 40px;${SIDES}">
      <div style="border-top:1px solid ${C.border};padding:28px 0 32px;text-align:center;">
        <p class="h" style="font-size:18px;color:${C.muted};font-style:italic;margin:0 0 6px;line-height:1.7;">"Every arrangement we make carries a little piece of us.<br/>We're glad it reached you."</p>
        <p style="font-size:12px;color:${C.pale};margin:0;">— The Bamboo Green team</p>
      </div></td></tr>

    <!-- CTA -->
    <tr><td class="panel-pad" style="background:${C.panel};padding:0 40px 40px;${SIDES}">
      <a href="https://bambooflorist.com.my" style="display:block;background:${C.brand};border-radius:4px;padding:16px 24px;text-align:center;margin-bottom:18px;color:${C.brandText};font-size:14px;letter-spacing:1px;text-transform:uppercase;font-weight:500;">Order again</a>
      <p style="font-size:14px;color:${C.muted};text-align:center;margin:0;line-height:1.8;">Questions about your order? WhatsApp us —<br/><a href="https://wa.me/60124778120" style="color:${C.brand};font-weight:600;">+6012-4778120</a></p>
    </td></tr>`;

  return {
    subject: `Your order ${orderNo} has arrived 🌷 — Bamboo Green Florist`,
    html: shell(inner),
    text: `Your order ${orderNo} has arrived${nm ? ', ' + nm : ''}.\n\nYour Bamboo Green Florist order has been delivered. Thank you for choosing us.\n`
      + (statusUrl ? `\nView delivery record: ${statusUrl}\n` : '') + `\nBamboo Green Florist`,
  };
}

/* ─────────────── OUT FOR DELIVERY ─────────────── */

export function buildOutForDeliveryEmail(order, opts = {}) {
  const nm = firstName(order);
  const orderNo = (order && order.name) || '';
  const statusUrl = opts.statusUrl || (order && order.order_status_url) || '';
  const dueDate = attr(order, 'Order Due Date') || '—';
  const dueTime = attr(order, 'Order Due Time') || '—';
  const recipient = attr(order, 'recipient_name') || ((order && order.shipping_address && order.shipping_address.name) || '');
  const contact = attr(order, 'recipient_phone') || ((order && order.shipping_address && order.shipping_address.phone) || '—');

  const inner = `
    <!-- HERO (ivory) -->
    <tr><td class="panel-pad" style="background:${C.card};padding:36px 40px 32px;${SIDES}border-bottom:1px solid ${C.border};">
      <span style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:${C.brandText};background:${C.brand};display:inline-block;padding:4px 12px;border-radius:99px;font-weight:500;">On its way</span>
      <h1 class="h" style="font-size:28px;color:${C.brand};margin:14px 0 8px;font-weight:400;line-height:1.3;">Your order is on its way${nm ? ', ' + esc(nm) : ''}.</h1>
      <p style="font-size:14px;color:${C.muted};margin:0;line-height:1.75;">It will arrive within your delivery window. We'll make sure it gets there safely.</p>
    </td></tr>

    <!-- SPINE -->
    <tr><td class="panel-pad" style="background:${C.panel};padding:32px 40px 24px;${SIDES}">
      ${spineDone('Order received', `${esc(fmtDateTime(order && order.created_at))} &nbsp;·&nbsp; ${esc(orderNo)}`)}
      ${spineDone('Prepared', 'Hand-crafted and ready for delivery', true)}
      <!-- Out for delivery — ACTIVE -->
      <table class="spine-table" cellpadding="0" cellspacing="0" border="0"><tr>
        <td width="48" valign="top" style="width:48px;"><table cellpadding="0" cellspacing="0" border="0" style="width:48px;">
          <tr><td align="center" style="padding-bottom:6px;"><div style="width:18px;height:18px;border-radius:50%;background:${C.brand};outline:4px solid ${C.pill};outline-offset:2px;margin:0 auto;"></div></td></tr>
          <tr><td align="center"><div style="width:2px;background:#ddd7ce;min-height:300px;margin:0 auto;"></div></td></tr>
        </table></td>
        <td valign="top" style="padding-left:18px;padding-bottom:28px;">
          <span style="display:inline-block;background:${C.pill};color:${C.pillInk};font-size:11px;letter-spacing:1.2px;text-transform:uppercase;padding:4px 12px;border-radius:99px;margin-bottom:10px;font-weight:500;">In transit</span>
          <p style="font-size:15px;font-weight:600;color:${C.brand};margin:0 0 5px;">Out for delivery</p>
          <p style="font-size:14px;color:${C.muted};margin:0 0 18px;line-height:1.75;">${esc(dueDate)} &nbsp;·&nbsp; ${esc(dueTime)}</p>
          <div style="background:${C.card};border-radius:4px;padding:18px 20px;border-left:3px solid ${C.brand};margin-bottom:12px;">
            <p style="font-size:12px;letter-spacing:1.2px;text-transform:uppercase;color:${C.faint};margin:0 0 14px;">Delivery details</p>
            <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:14px;"><tr>
              <td class="two-col-td" width="50%" valign="top" style="padding-right:10px;">
                <p style="font-size:11px;color:${C.faint};margin:0 0 4px;text-transform:uppercase;letter-spacing:1px;">Date</p>
                <p style="font-size:14px;color:${C.brand};font-weight:500;margin:0;">${esc(dueDate)}</p></td>
              <td class="two-col-td" width="50%" valign="top">
                <p style="font-size:11px;color:${C.faint};margin:0 0 4px;text-transform:uppercase;letter-spacing:1px;">Time slot</p>
                <p style="font-size:14px;color:${C.brand};font-weight:500;margin:0;">${esc(dueTime)}</p></td>
            </tr></table>
            <div style="border-top:1px solid ${C.borderSoft};padding-top:14px;">
              <p style="font-size:11px;color:${C.faint};margin:0 0 10px;text-transform:uppercase;letter-spacing:1px;">Recipient</p>
              <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:12px;"><tr>
                <td class="two-col-td" width="50%" valign="top" style="padding-right:10px;">
                  <p style="font-size:11px;color:${C.faint};margin:0 0 3px;">Name</p>
                  <p style="font-size:14px;color:${C.ink};font-weight:500;margin:0;">${esc(recipient) || '—'}</p></td>
                <td class="two-col-td" width="50%" valign="top">
                  <p style="font-size:11px;color:${C.faint};margin:0 0 3px;">Contact</p>
                  <p style="font-size:14px;color:${C.ink};font-weight:500;margin:0;">${esc(contact)}</p></td>
              </tr></table>
              <p style="font-size:11px;color:${C.faint};margin:0 0 3px;">Address</p>
              <p style="font-size:14px;color:${C.ink};margin:0;line-height:1.6;">${addressBlock(order)}</p>
            </div>
          </div>
          ${statusUrl ? `<div style="background:${C.card};border-radius:4px;padding:18px 20px;border-left:3px solid ${C.accent2};margin-top:12px;">
            <p style="font-size:12px;letter-spacing:1.2px;text-transform:uppercase;color:${C.faint};margin:0 0 14px;">Live tracking</p>
            <p style="font-size:13px;color:${C.body};margin:0 0 12px;line-height:1.65;">Track your delivery in real time — see the current status of your order at any time.</p>
            <a href="${esc(statusUrl)}" style="display:block;background:${C.brand};border-radius:4px;padding:13px 20px;text-align:center;font-size:13px;color:${C.brandText};font-weight:500;letter-spacing:0.5px;text-transform:uppercase;">Track my delivery →</a>
          </div>` : ''}
        </td></tr></table>
      <!-- Delivered — pending -->
      <table class="spine-table" cellpadding="0" cellspacing="0" border="0"><tr>
        <td width="48" valign="top" style="width:48px;padding-top:4px;"><div style="width:13px;height:13px;border-radius:50%;background:#ddd7ce;margin:0 auto;"></div></td>
        <td valign="top" style="padding-left:18px;padding-top:4px;padding-bottom:8px;">
          <p style="font-size:15px;color:${C.pale};margin:0 0 4px;font-weight:500;">Delivered</p>
          <p style="font-size:14px;color:${C.pale};margin:0;">Pending arrival</p></td>
      </tr></table>
    </td></tr>

    <!-- WHAT TO EXPECT -->
    <tr><td class="panel-pad" style="background:${C.panel};padding:0 40px;${SIDES}">
      <div style="border-top:1px solid ${C.border};padding-top:28px;padding-bottom:32px;">
        <p style="font-size:12px;letter-spacing:1.5px;text-transform:uppercase;color:${C.faint};margin:0 0 16px;font-weight:500;">What to expect</p>
        <div class="expect-card expect-card-brand"><p class="expect-title">Our driver will call before handing over</p>
          <p class="expect-body">Please make sure the recipient is reachable at the contact number provided. Our driver will call to let them know the flowers have arrived.</p></div>
        <div class="expect-card expect-card-brand"><p class="expect-title">Arrival time may vary slightly</p>
          <p class="expect-body">We work with fresh blooms and navigate real traffic — we ask for your patience within the window. Rest assured your order is being handled with care.</p></div>
        <div class="expect-card expect-card-muted" style="margin-bottom:0;"><p class="expect-title">Condo &amp; apartment deliveries</p>
          <p class="expect-body">If access is restricted and the recipient cannot be reached, flowers will be left at the guardhouse or lobby reception to keep them safe.</p></div>
      </div></td></tr>

    <!-- LAST-MINUTE CHANGES -->
    <tr><td class="panel-pad" style="background:${C.panel};padding:0 40px;${SIDES}">
      <div style="border-top:1px solid ${C.border};padding-top:24px;padding-bottom:32px;">
        <div style="background:${C.card};border-radius:4px;border-left:3px solid ${C.brand};padding:18px 20px;">
          <p style="font-size:14px;font-weight:600;color:${C.brand};margin:0 0 6px;">Need to make a last-minute change?</p>
          <p style="font-size:13px;color:${C.body};margin:0 0 14px;line-height:1.7;">If the delivery address is incorrect or the recipient is unavailable, please WhatsApp us immediately so we can help coordinate before the handoff.</p>
          <a href="https://wa.me/60124778120" style="display:inline-block;background:${C.brand};border-radius:4px;padding:12px 20px;font-size:13px;color:${C.brandText};font-weight:500;letter-spacing:0.3px;">WhatsApp us now — +6012-4778120</a>
        </div></div></td></tr>

    <!-- CTA -->
    <tr><td class="panel-pad" style="background:${C.panel};padding:0 40px 40px;${SIDES}">
      <a href="${esc(statusUrl || 'https://bambooflorist.com.my')}" style="display:block;background:${C.brand};border-radius:4px;padding:16px 24px;text-align:center;color:${C.brandText};font-size:14px;letter-spacing:1px;text-transform:uppercase;font-weight:500;">View order details</a>
    </td></tr>`;

  return {
    subject: `Your order ${orderNo} is on its way 🚚 — Bamboo Green Florist`,
    html: shell(inner),
    text: `Your order ${orderNo} is on its way${nm ? ', ' + nm : ''}.\n\n${dueDate} · ${dueTime}\nIt will arrive within your delivery window.\n`
      + (statusUrl ? `\nTrack / view order: ${statusUrl}\n` : '') + `\nBamboo Green Florist`,
  };
}

export function buildOrderEmail(type, order, opts) {
  return type === 'out_for_delivery' ? buildOutForDeliveryEmail(order, opts) : buildDeliveredEmail(order, opts);
}
