'use strict';
// Deterministic fallback "agent" for running without any LLM, and the safety net when an LLM
// endpoint is unreachable. Understands a fixed set of English and German phrasings.
const NUM = '(\\d+(?:[.,]\\d+)?)';
const n = (s) => Number(String(s).replace(',', '.'));
const EN = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100 };
const DE = { eins: 1, ein: 1, eine: 1, einer: 1, zwei: 2, drei: 3, vier: 4, 'fünf': 5, sechs: 6, sieben: 7, acht: 8, neun: 9, zehn: 10, zwanzig: 20, 'dreißig': 30, vierzig: 40, 'fünfzig': 50, sechzig: 60, siebzig: 70, achtzig: 80, neunzig: 90, hundert: 100 };

function detectLang(t) {
  return /\b(rechnung|stunden?|für|und|euro\b.*\bfür|wer schuldet|erinnere?|mahnung|bezahlt|überweisung|storn\w*|erstatt\w*|bitte|offen)\b|[äöüß]/i.test(t) ? 'de' : 'en';
}
function normalizeNumbers(t) {
  return t
    .replace(/\b(anderthalb)\b/gi, '1.5')
    .replace(/\b(ein|zwei|drei|vier|fünf|sechs|sieben|acht|neun|zehn)einhalb\b/gi, (_, w) => String(DE[w.toLowerCase()] + 0.5))
    .replace(/\b(one|two|three|four|five|six|seven|eight|nine|ten) and a half\b/gi, (_, w) => String(EN[w.toLowerCase()] + 0.5))
    .replace(/\b(twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)[- ](one|two|three|four|five|six|seven|eight|nine)\b/gi, (_, a, b) => String(EN[a.toLowerCase()] + EN[b.toLowerCase()]))
    .replace(/\b(one|two|three|four|five|six|seven|eight|nine|ten|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred)\b/gi, (w) => String(EN[w.toLowerCase()]))
    .replace(/\b(eins|zwei|drei|vier|fünf|sechs|sieben|acht|neun|zehn|zwanzig|dreißig|vierzig|fünfzig|sechzig|siebzig|achtzig|neunzig|hundert)\b/gi, (w) => String(DE[w.toLowerCase()]))
    .replace(/\b(a|an|one) half\b/gi, '0.5')
    .replace(/(\d)\s*,\s*(\d{1,2})\b/g, '$1.$2');
}
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const STOP = '(?=\\s*(?:,|;|\\bplus\\b|\\band\\b|\\bund\\b|\\bdue\\b|\\bfällig\\b|\\.(?:\\s|$)|$))';
const CUR = '(?:euros?|eur|€|dollars?|\\$)?';

function parseInvoice(text, cfg) {
  const t = normalizeNumbers(text);
  const lang = detectLang(text);
  let cust = t.match(/(?:invoice|bill)\s+(?:for\s+)?(.+?)\s+(?:for|over)\s/i) || t.match(/rechnung\s+(?:an|für)\s+(?:die\s+|den\s+|das\s+)?(.+?)(?::|,|\s+über\s|\s+für\s)/i);
  if (!cust) return null;
  const items = [];
  const hourRe = new RegExp(`${NUM}\\s*(?:hours?|hrs?|h|stunden?|std\\.?)\\s+(?:of\\s+|on\\s+(?:the\\s+)?)?(.+?)(?:\\s+(?:at|à|a|zu|für|je)\\s+${NUM}\\s*${CUR}\\s*(?:an|per|/|pro|die|je)\\s*(?:hour|stunde|h))?${STOP}`, 'gi');
  let m;
  while ((m = hourRe.exec(t))) items.push({ description: cap(m[2].trim()), quantity: n(m[1]), unit_price: m[3] ? n(m[3]) : cfg.business.hourlyRate, unit: 'HOURS' });
  const partRe = new RegExp(`(?:plus|and|und)\\s+${NUM}\\s*${CUR}\\s+(?:for|in|für)\\s+(?:the\\s+|a\\s+|an\\s+|new\\s+|die\\s+|den\\s+|das\\s+|eine?n?\\s+|neue?n?\\s+)*(.+?)${STOP}`, 'gi');
  while ((m = partRe.exec(t))) items.push({ description: cap(m[2].trim()), quantity: 1, unit_price: n(m[1]), unit: 'QUANTITY' });
  const partRe2 = new RegExp(`(?:plus|and|und)\\s+(?:a\\s+|an\\s+|new\\s+|eine?n?\\s+|neue?n?\\s+)*([a-zäöüß][\\wäöüß -]{2,40}?),?\\s+${NUM}\\s*${CUR}${STOP}`, 'gi');
  while ((m = partRe2.exec(t))) if (!items.some((i) => i.unit_price === n(m[2]) && i.unit === 'QUANTITY')) items.push({ description: cap(m[1].trim()), quantity: 1, unit_price: n(m[2]), unit: 'QUANTITY' });
  if (!items.length) return null;
  const due = t.match(/(?:due in|fällig in|zahlbar in)\s+(\d+)\s+(?:days|tagen)/i);
  const email = t.match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
  return { lang, args: { customer: cust[1].replace(/^(the|a)\s+/i, '').trim(), items, ...(due ? { due_in_days: Number(due[1]) } : {}), ...(email ? { customer_email: email[0].replace(/\.$/, '') } : {}) } };
}

const T = {
  en: {
    needEmail: (c) => `I don't know ${c} yet. What is their email address?`,
    failed: (e) => `That didn't work: ${e}`,
    blocked: (r) => `I can't do that: ${r}`,
    drafted: (d) => `Draft ${d.number} for ${d.customer} is ready: ${d.total}. It's waiting for your signature.`,
    none: 'Nobody owes you anything right now.',
    list: (r, s) => `${r.count} ${s} invoice${r.count > 1 ? 's' : ''}, ${r.total_due} in total: ` + r.invoices.slice(0, 3).map((i) => `${i.customer} ${i.amount_due}${i.status === 'OVERDUE' ? ' (overdue)' : ''}`).join(', ') + '.',
    queued: (what) => `${what} is ready and waiting for your signature.`,
    summary: (r) => `Outstanding ${r.outstanding}, of which ${r.overdue} is overdue. Paid so far: ${r.paid}.`,
    help: 'Offline mode understands: "Invoice <customer> for 3 hours <job> at 65 an hour plus 40 for parts", "Who owes me money?", "Remind <customer>", "<customer> paid cash", "Refund <customer> 20 euros", "Cancel the invoice for <customer>".',
    rem: (c) => `A reminder for ${c}`, pay: 'Recording that payment', ref: 'The refund', can: 'The cancellation',
  },
  de: {
    needEmail: (c) => `${c} kenne ich noch nicht. Wie lautet die E-Mail-Adresse?`,
    failed: (e) => `Das hat nicht geklappt: ${e}`,
    blocked: (r) => `Das geht nicht: ${r}`,
    drafted: (d) => `Entwurf ${d.number} für ${d.customer} ist fertig: ${d.total}. Er wartet auf deine Freigabe.`,
    none: 'Im Moment schuldet dir niemand etwas.',
    list: (r) => `${r.count} offene Rechnung${r.count > 1 ? 'en' : ''}, insgesamt ${r.total_due}: ` + r.invoices.slice(0, 3).map((i) => `${i.customer} ${i.amount_due}${i.status === 'OVERDUE' ? ' (überfällig)' : ''}`).join(', ') + '.',
    queued: (what) => `${what} ist vorbereitet und wartet auf deine Freigabe.`,
    summary: (r) => `Offen: ${r.outstanding}, davon überfällig ${r.overdue}. Bezahlt: ${r.paid}.`,
    help: 'Offline verstehe ich z. B.: "Rechnung an <Kunde>: 3 Stunden <Arbeit> zu 65 Euro pro Stunde, plus 40 Euro für Material", "Wer schuldet mir Geld?", "Erinnere <Kunde>", "<Kunde> hat bar bezahlt".',
    rem: (c) => `Die Zahlungserinnerung an ${c}`, pay: 'Die Zahlung', ref: 'Die Erstattung', can: 'Die Stornierung',
  },
};

function offlinePlan(text, cfg) {
  const t = text.trim();
  const lang = detectLang(t);
  const L = T[lang];
  const guard = (r, ok) => (r.blocked ? L.blocked(r.reasons[0]) : r.error ? L.failed(r.error) : ok());
  if (/\b(invoice|bill|rechnung)\b/i.test(t) && /\b(for|über|für|an)\b|:/i.test(t) && !/\b(cancel|storn)/i.test(t)) {
    const p = parseInvoice(t, cfg);
    if (p) return { lang, tool: 'draft_invoice', args: p.args, say: (r) => r.needs ? L.needEmail(p.args.customer) : r.error ? L.failed(r.error) : r.approval?.blocked ? L.blocked(r.approval.reasons[0]) : L.drafted(r.draft) };
  }
  if (/who owes|outstanding|open invoices|unpaid|overdue|schuldet|offene rechnungen|überfällig|wer zahlt/i.test(t)) {
    const status = /overdue|late|überfällig/i.test(t) ? 'overdue' : 'open';
    return { lang, tool: 'list_invoices', args: { status }, say: (r) => (r.count === 0 ? L.none : L.list(r, status)) };
  }
  let m = t.match(/(?:remind|erinnere?|mahnung an|zahlungserinnerung an)\s+(?:the\s+|die\s+|den\s+)?(.+?)(?:\s+(?:about|to pay|again|please|nochmal|bitte|an die zahlung).*)?[.!?]?$/i);
  if (m) return { lang, tool: 'propose_reminder', args: { customer: m[1] }, say: (r) => guard(r, () => L.queued(L.rem(m[1]))) };
  m = t.match(/(.+?)\s+(?:has\s+|hat\s+)?(?:paid|bezahlt|gezahlt)\s+(?:me\s+|mir\s+)?(?:in\s+|by\s+|per\s+|in\s+)?(cash|bar|bank transfer|transfer|überweisung|cheque|check|scheck)(?:\s+${NUM})?/i)
    || t.match(/(.+?)\s+(?:hat\s+)?(bar|per überweisung)\s+(?:bezahlt|gezahlt)/i);
  if (m) {
    const method = /cash|bar/i.test(m[2]) ? 'CASH' : /che|sche/i.test(m[2]) ? 'CHECK' : 'BANK_TRANSFER';
    return { lang, tool: 'propose_record_payment', args: { customer: m[1], method, ...(m[3] ? { amount: n(m[3]) } : {}) }, say: (r) => guard(r, () => L.queued(L.pay)) };
  }
  const nt = normalizeNumbers(t);
  m = nt.match(/(?:refund|erstatte)\s+(?:the\s+)?(.+?)\s+(\d+(?:\.\d+)?)\s*(?:euros?|eur|€)?\s*[.!?]?$/i);
  const m2 = nt.match(/(?:refund|erstatte)\s+(\d+(?:\.\d+)?)\s*(?:euros?|eur|€)?\s+(?:to|an|für|for)\s+(?:the\s+|die\s+|den\s+)?(.+?)[.!?]?$/i);
  if (m2) m = [m2[0], m2[2], m2[1]];
  if (m) return { lang, tool: 'propose_refund', args: { customer: m[1], amount: n(m[2]) }, say: (r) => guard(r, () => L.queued(L.ref)) };
  m = t.match(/(?:cancel|storniere?)\s+(?:the\s+|die\s+)?(?:invoice\s+|rechnung\s+)?(?:for\s+|to\s+|an\s+|für\s+|von\s+|from\s+)?(?:the\s+|die\s+|der\s+)?(.+?)(?:\s+(?:invoice|rechnung))?[.!?]?$/i);
  if (m) return { lang, tool: 'propose_cancel', args: { customer: m[1] }, say: (r) => guard(r, () => L.queued(L.can)) };
  if (/summary|how much|how am i doing|total|übersicht|wie viel|umsatz/i.test(t)) return { lang, tool: 'get_summary', args: {}, say: (r) => L.summary(r) };
  return { lang, help: L.help };
}

module.exports = { offlinePlan, parseInvoice, detectLang, normalizeNumbers };
