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

    const birthday    = dateOk((b.birthday || '').trim());
    const anniversary = dateOk((b.anniversary || '').trim());
    const suggestion  = (b.suggestion || '').trim() || null;
    const quizType    = (b.report_type || '').trim() || null;
    const answers     = b.answers != null ? b.answers : null;   // full quizAnswers (jsonb)
    const lang        = (b.lang || '').trim() || null;
    const page        = (b.source_page || '').trim() || null;

    const nowIso = new Date().toISOString();
    const quizData = { type: quizType, answers, lang, page, name, email, phone: phoneRaw, submitted_at: nowIso };
    const prefColour = joinAnswer(answers, 3);   // Q3.5 colour
    const prefStyle  = joinAnswer(answers, 2);   // Q3 style

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
      const { error } = await sb.from('customers').update(upd).eq('id', customerId);
      if (error) throw error;
    } else {
      // NEW marketing contact captured by the quiz.
      matched = false;
      const ins = {
        name, email, phone: phoneRaw, source: 'quiz',
        did_quiz: true, quiz_at: nowIso, quiz_type: quizType, quiz_data: quizData,
        birthday, anniversary, updated_at: nowIso,
      };
      const { data, error } = await sb.from('customers').insert(ins).select('id').single();
      if (error) throw error;
      customerId = data.id;
    }

    // Map colour + style into the existing free-text preference fields (best-effort).
    try {
      const pref = { customer_id: customerId, updated_at: nowIso };
      if (prefColour) pref.colour_mood = prefColour;
      if (prefStyle)  pref.style = prefStyle;
      if (pref.colour_mood || pref.style)
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
