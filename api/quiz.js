// POST /api/quiz
// Receives a Bamboo Green Florist landing-page quiz submission and links it into the
// bambooflowerclub CRM — the SAME Supabase `customers` table the app reads.
//
// Matching is by WhatsApp number (normalized the same way the app does):
//  - EXISTING customer  → keep their identity/segment/source untouched; just flag
//    did_quiz, stamp quiz_at, store the answers (the "QUIZ" badge), and fill only
//    empty contact gaps. A regular WhatsApp customer stays "Regular / WhatsApp" and
//    simply gains a QUIZ badge.
//  - UNKNOWN number     → create a new marketing contact with source = 'quiz'.
//
// CRM-owned fields are never clobbered. Public endpoint (CORS) — the landing page
// holds no secrets; this server uses the Supabase service key.

import { createClient } from '@supabase/supabase-js';

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;

// Origins allowed to POST the quiz: the public landing pages + Vercel previews + dev.
const ALLOW = [
  'https://ourstory.bambooflorist.com.my',
  'https://bambooflorist.com.my',
  'https://www.bambooflorist.com.my',
];
function setCors(req, res) {
  const origin = req.headers.origin || '';
  const ok = ALLOW.includes(origin) || /\.vercel\.app$/.test(origin) || /^http:\/\/localhost(:\d+)?$/.test(origin);
  res.setHeader('Access-Control-Allow-Origin', ok ? origin : ALLOW[0]);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// Mirror flori.html _normPhone: digits only; Malaysian +60 -> leading 0.
function normPhone(s) {
  let d = String(s || '').replace(/\D/g, '');
  if (d.startsWith('60')) d = '0' + d.slice(2);
  return d;
}
const dateOk = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '') ? s : null;

// answers[idx] is an array (Q2–Q6) or {main:[],sub:{}} for Q1 — join the chosen
// option texts into one string for the CRM's free-text preference fields.
function joinAnswer(answers, idx) {
  if (!answers) return null;
  const a = Array.isArray(answers) ? answers[idx] : (answers[idx] || answers[String(idx)]);
  if (!a) return null;
  const list = Array.isArray(a) ? a : (a.main || []);
  const s = list.filter(Boolean).join(', ');
  return s || null;
}

// Quiz answers (Chinese on the CN pages) → the CRM's canonical English option values.
// Unknown values pass through unchanged, so EN-page answers that already match survive.
const FLORAL_MAP = {'鲜花桌花 / 瓶插花':'Table / vase','精美鲜花束':'Fresh bouquets','永生花 / 高档仿真花摆件':'Preserved / artificial','兰花组盆（如蝴蝶兰）':'Orchid arrangements','香皂花':'Soap flowers'};
const STYLE_MAP  = {'经典浪漫（粉红、白、红）':'Classic romantic','韩式小清新 / 柔和马卡龙色':'Korean soft','经典法式 / 自然野趣':'French garden','高级东方禅意 / 复古色调':'Oriental elegance','现代轻奢 / 金属时尚感':'Modern luxury'};
const COLOUR_MAP = {'白色 / 米色 / 香槟':'White / Cream / Champagne','粉色 / 珊瑚 / 桃':'Pink / Coral / Peach','红色 / 酒红':'Red / Burgundy','紫色 / 蓝紫':'Purple / Blue-violet','蓝色':'Blue','黄色 / 橙色':'Yellow / Orange','橙色 / 暖色':'Yellow / Orange','自然 / 绿色':'Nature / Green','交给你们决定':'Leave it to you'};
const FREQ_MAP   = {'每周 / 定期回购':'Weekly or regular','每月 1-2 次':'Once or twice a month','每逢重要节日 / 纪念日才会购买':'Special occasions only','偶尔 / 随机，看心情':'Occasionally'};
const VALUES_MAP = {'花材的新鲜度与品质':'Freshness & quality','花艺师的设计感与独特审美':"Designer's eye & originality",'品牌口碑与精致的包装':'Brand & presentation','价格与高性价比':'Good value','配送的准时与服务态度':'Delivery & service'};
const CHANNEL_MAP= {'WhatsApp':'WhatsApp','Instagram / Facebook':'Instagram / Facebook','小红书':'Xiaohongshu','官网 / Shopify':'Website / Shopify','其他':'Other'};
const OCC_MAP    = {'生日':'Birthday','纪念日':'Anniversary','婚礼':'Wedding','毕业':'Graduation','新生儿':'New Baby','情人节':"Valentine's",'母亲节':"Mother's Day",'父亲节':"Father's Day",'农历新年':'Chinese New Year','商务活动 / 宴会桌花 / 年会':'Corporate Events','开张大吉 / 祝贺花篮 / 店庆':'Grand Opening','商务送礼 / 感谢客户 / 员工福利':'Corporate Gifting','居家日常装点 / 悦己消费':'Home Décor / Self','人生特殊关怀 / 慰问 / 探病':'Sympathy / Hospital'};
const OCC_VALUES = new Set(Object.values(OCC_MAP));
// answers[idx] -> array of chosen option texts (Q1 uses {main,sub}).
function answerList(answers, idx){
  if (!answers) return [];
  const a = Array.isArray(answers) ? answers[idx] : (answers[idx] || answers[String(idx)]);
  if (!a) return [];
  return Array.isArray(a) ? a.filter(Boolean) : (a.main||[]).filter(Boolean);
}
function q1SubList(answers){   // Q1 sub-option values (the specific occasions)
  const a = answers ? (Array.isArray(answers)?answers[0]:(answers[0]||answers['0'])) : null;
  if (!a || !a.sub) return [];
  const out=[]; Object.values(a.sub).forEach(arr=>(arr||[]).forEach(v=>{ if(v) out.push(v); })); return out;
}
function mapVals(list, dict){ const out=[]; (list||[]).forEach(v=>{ const m=(dict[v]!==undefined)?dict[v]:v; if(m) out.push(m); }); return [...new Set(out)]; }

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!SB_URL || !SB_KEY) return res.status(500).json({ error: 'Supabase env not configured' });

  try {
    const b = req.body || {};
    const name  = (b.name || '').trim() || null;
    const email = (b.email || '').trim() || null;
    const phoneRaw = (b.phone || '').trim();
    const norm = normPhone(phoneRaw);
    if (!norm || norm.length < 7) return res.status(400).json({ error: 'A valid phone is required' });

    const birthdayRaw    = (b.birthday || '').trim();
    const anniversaryRaw = (b.anniversary || '').trim();
    const birthday    = dateOk(birthdayRaw);     // only populate the date columns if ISO
    const anniversary = dateOk(anniversaryRaw);
    const suggestion  = (b.suggestion || '').trim() || null;
    const quizType    = (b.report_type || '').trim() || null;
    const answers     = b.answers != null ? b.answers : null;   // full quizAnswers (jsonb)
    const lang        = (b.lang || '').trim() || null;
    const page        = (b.source_page || '').trim() || null;

    const nowIso = new Date().toISOString();
    // Keep the raw free-text birthday/anniversary/suggestion too — the landing page
    // collects these as free text (e.g. "6月12日"), which won't fit the date columns,
    // so we'd otherwise lose them. quiz_data preserves everything as submitted.
    const quizData = { type: quizType, answers, lang, page, name, email, phone: phoneRaw,
      birthday: birthdayRaw || null, anniversary: anniversaryRaw || null, suggestion, submitted_at: nowIso };
    // Map quiz answers → canonical preference columns (best-effort).
    const occ        = mapVals([...answerList(answers,0), ...q1SubList(answers)], OCC_MAP).filter(v=>OCC_VALUES.has(v));
    const floral     = mapVals(answerList(answers,1), FLORAL_MAP);
    const style      = mapVals(answerList(answers,2), STYLE_MAP);
    const colour     = mapVals(answerList(answers,3), COLOUR_MAP);
    const valuesMost = mapVals(answerList(answers,5), VALUES_MAP).slice(0,2);
    const purchaseFreq = mapVals(answerList(answers,4), FREQ_MAP)[0] || null;
    const channel    = mapVals(answerList(answers,6), CHANNEL_MAP);
    const personalityType = quizType || null;

    const sb = createClient(SB_URL, SB_KEY);

    // Find an existing customer by normalized WhatsApp number. Narrow with an ilike on
    // the national significant digits (matches contiguously-stored numbers), then
    // confirm with the app's own normalization to drop substring false-positives.
    const nsn = norm.replace(/^0/, '');
    let match = null;
    const { data: cands } = await sb.from('customers')
      .select('id, phone, email, birthday, anniversary')
      .ilike('phone', `%${nsn}%`).limit(50);
    if (Array.isArray(cands)) match = cands.find(c => normPhone(c.phone) === norm) || null;

    let customerId, matched;
    if (match) {
      // EXISTING: keep identity/segment/source; flag the quiz + fill only empty gaps.
      matched = true; customerId = match.id;
      const upd = { did_quiz: true, quiz_at: nowIso, quiz_type: quizType, quiz_data: quizData, updated_at: nowIso };
      if (!match.email && email)             upd.email = email;
      if (!match.birthday && birthday)       upd.birthday = birthday;
      if (!match.anniversary && anniversary) upd.anniversary = anniversary;
      if (channel.length)                    upd.preferred_channel = channel;
      const { error } = await sb.from('customers').update(upd).eq('id', customerId);
      if (error) throw error;
    } else {
      // NEW marketing contact captured by the quiz.
      matched = false;
      const ins = {
        name, email, phone: phoneRaw, source: 'quiz',
        did_quiz: true, quiz_at: nowIso, quiz_type: quizType, quiz_data: quizData,
        birthday, anniversary, preferred_channel: channel.length?channel:null, updated_at: nowIso,
      };
      const { data, error } = await sb.from('customers').insert(ins).select('id').single();
      if (error) throw error;
      customerId = data.id;
    }

    // Auto-fill preference columns from the quiz (best-effort; only non-empty fields,
    // so a CS-entered value is never wiped by a blank quiz answer).
    try {
      const pref = { customer_id: customerId, updated_at: nowIso };
      if (occ.length)        pref.occasion = occ;
      if (floral.length)     pref.floral_type = floral;
      if (style.length)      pref.style = style;
      if (colour.length)     pref.colour_preference = colour;
      if (valuesMost.length) pref.values_most = valuesMost;
      if (purchaseFreq)      pref.purchase_frequency = purchaseFreq;
      if (personalityType)   pref.personality_type = personalityType;
      if (Object.keys(pref).length > 2)
        await sb.from('customer_preferences').upsert(pref, { onConflict: 'customer_id' });
    } catch (e) { console.error('quiz prefs:', e.message); }

    // Their written suggestion → a visible note (best-effort).
    if (suggestion) {
      try { await sb.from('customer_notes').insert({ customer_id: customerId, note: '[Quiz] ' + suggestion, author_name: 'Quiz' }); }
      catch (e) { console.error('quiz note:', e.message); }
    }

    console.log(`[Quiz] ${matched ? 'tagged existing' : 'new'} customer ${customerId} (${name || 'no name'})`);
    return res.status(200).json({ ok: true, customer: customerId, matched });
  } catch (e) {
    console.error('quiz endpoint failed:', e.message);
    return res.status(500).json({ error: e.message });
  }
}
