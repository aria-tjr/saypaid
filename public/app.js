/* SayPaid front-end. Vanilla JS, no build step. */
(() => {
'use strict';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (cents, cur = 'EUR') => new Intl.NumberFormat('en-IE', { style: 'currency', currency: cur }).format((cents || 0) / 100);
const day = (iso) => (iso ? new Date(iso.length === 10 ? iso + 'T12:00:00' : iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '–');
const when = (iso) => new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const initials = (s) => String(s || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
const api = async (path, opts = {}) => {
  const r = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
};

// ------------------------------------------------------------------ icons (simple stroke set)
const P = {
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
  send: '<path d="M4 12 20 4l-6 16-3-7-7-1z"/>',
  spark: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6"/>',
  pen: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m14 6 4 4"/>',
  shield: '<path d="M12 3 5 6v6c0 4.5 3 7.5 7 9 4-1.5 7-4.5 7-9V6z"/><path d="m9 12 2 2 4-4"/>',
  chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  wallet: '<rect x="3" y="6" width="18" height="13" rx="2"/><path d="M16 12h2M3 9h18"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  check: '<path d="m5 12 5 5L20 7"/>',
  checkc: '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/>',
  bell: '<path d="M6 16V11a6 6 0 1 1 12 0v5l2 2H4z"/><path d="M10 20a2 2 0 0 0 4 0"/>',
  cash: '<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6 9v.01M18 15v.01"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>',
  ban: '<circle cx="12" cy="12" r="9"/><path d="m6 6 12 12"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>',
  volume: '<path d="M4 9v6h4l5 4V5L8 9z"/><path d="M16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11"/>',
  mute: '<path d="M4 9v6h4l5 4V5L8 9z"/><path d="m17 9 5 6M22 9l-5 6"/>',
  reset: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  ext: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  dl: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  warn: '<path d="M12 3 2 20h20z"/><path d="M12 10v4M12 17v.01"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.01"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  zap: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
};
const icon = (n, cls = '') => `<svg class="ico ${cls}" viewBox="0 0 24 24" aria-hidden="true">${P[n] || ''}</svg>`;
const setIcon = (sel, n, cls) => { const el = $(sel); if (el) el.innerHTML = icon(n, cls); };

// ------------------------------------------------------------------ prefs
const prefs = { theme: localStorage.sp_theme || 'light', lang: localStorage.sp_lang || 'en-US', speak: localStorage.sp_speak !== '0' };
const applyPrefs = () => {
  document.documentElement.dataset.theme = prefs.theme;
  setIcon('#theme', prefs.theme === 'dark' ? 'sun' : 'moon');
  setIcon('#speak', prefs.speak ? 'volume' : 'mute');
  $$('#lang button').forEach((b) => b.classList.toggle('on', b.dataset.l === prefs.lang));
  $('#text').placeholder = prefs.lang === 'de-DE' ? 'z. B. Rechnung an Kraemer Bakery: 2 Stunden Ofeninspektion, plus 25 Euro für die Anfahrt' : 'e.g. Invoice Cafe Morgenrot for 3.5 hours espresso machine repair at 70 an hour, plus 48 euros for a pump gasket';
};
$('#theme').onclick = () => { prefs.theme = prefs.theme === 'dark' ? 'light' : 'dark'; localStorage.sp_theme = prefs.theme; applyPrefs(); };
$('#speak').onclick = () => { prefs.speak = !prefs.speak; localStorage.sp_speak = prefs.speak ? '1' : '0'; if (!prefs.speak) speechSynthesis?.cancel(); applyPrefs(); };
$$('#lang button').forEach((b) => (b.onclick = () => { prefs.lang = b.dataset.l; localStorage.sp_lang = prefs.lang; applyPrefs(); }));
[['#i-spark', 'spark'], ['#i-pen', 'pen'], ['#i-shield', 'shield'], ['#i-chart', 'chart'], ['#i-k1', 'wallet'], ['#i-k2', 'clock'], ['#i-k3', 'checkc'], ['#reset', 'reset'], ['#mic', 'mic'], ['#orb', 'mic']].forEach(([s, n]) => setIcon(s, n));
$('#send').insertAdjacentHTML('afterbegin', icon('send', 'sm'));

// ------------------------------------------------------------------ toasts + speech
function toast(kind, title, sub = '', ms = 5200) {
  const ic = { ok: 'checkc', err: 'warn', info: 'info', money: 'cash' }[kind] || 'info';
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = `<div class="ti">${icon(ic)}</div><div><b>${esc(title)}</b>${sub ? `<span>${esc(sub)}</span>` : ''}</div>`;
  $('#toasts').prepend(el);
  $$('#toasts .toast:not(.out)').slice(3).forEach((t) => { t.classList.add('out'); setTimeout(() => t.remove(), 320); });
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 320); }, ms);
}
function speak(text, lang) {
  if (!prefs.speak || !('speechSynthesis' in window) || !text) return;
  const u = new SpeechSynthesisUtterance(text);
  u.lang = lang === 'de' ? 'de-DE' : lang === 'en' ? 'en-US' : prefs.lang;
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
}

// ------------------------------------------------------------------ voice capture with live waveform
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null, stream = null, raf = 0, analyser = null;
function drawWave(synthetic) {
  const c = $('#wave'), g = c.getContext('2d');
  const data = new Uint8Array(64);
  const bars = 48;
  const color = getComputedStyle(document.documentElement).getPropertyValue('--blue').trim() || '#0070e0';
  const loop = (t) => {
    g.clearRect(0, 0, c.width, c.height);
    if (analyser) analyser.getByteFrequencyData(data);
    for (let i = 0; i < bars; i++) {
      let v = analyser ? data[Math.floor(i * 64 / bars)] / 255 : 0;
      if (synthetic || !analyser) v = 0.18 + 0.55 * Math.abs(Math.sin(t / 180 + i * 0.55)) * (0.5 + 0.5 * Math.sin(t / 420 + i / 5)) * (synthetic ? 1 : 0.5);
      const h = Math.max(6, v * c.height);
      const x = i * (c.width / bars) + 3;
      g.fillStyle = color;
      g.globalAlpha = 0.35 + v * 0.65;
      g.beginPath();
      g.roundRect ? g.roundRect(x, (c.height - h) / 2, c.width / bars - 6, h, 4) : g.rect(x, (c.height - h) / 2, c.width / bars - 6, h);
      g.fill();
    }
    raf = requestAnimationFrame(loop);
  };
  raf = requestAnimationFrame(loop);
}
function showListening(on, synthetic = false) {
  $('#listening').classList.toggle('hidden', !on);
  $('#mic').classList.toggle('on', on);
  cancelAnimationFrame(raf);
  if (on) { $('#live').textContent = synthetic ? '' : (prefs.lang === 'de-DE' ? 'Sprich jetzt…' : 'Speak now…'); drawWave(synthetic); }
}
async function startMic() {
  if (!SR) { toast('info', 'Voice input needs Chrome or Edge', 'You can type instead; it uses the same pipeline.'); return; }
  if (rec) { rec.stop(); return; }
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); const ac = new AudioContext(); analyser = ac.createAnalyser(); analyser.fftSize = 128; ac.createMediaStreamSource(stream).connect(analyser); } catch { analyser = null; }
  rec = new SR();
  rec.lang = prefs.lang;
  rec.interimResults = true;
  let finalText = '';
  rec.onstart = () => showListening(true);
  rec.onresult = (e) => { const t = Array.from(e.results).map((r) => r[0].transcript).join(' '); $('#live').textContent = t; $('#text').value = t; if (e.results[e.results.length - 1].isFinal) finalText = t; };
  rec.onerror = (e) => toast('err', 'Microphone error', e.error);
  rec.onend = () => { showListening(false); stream?.getTracks().forEach((t) => t.stop()); analyser = null; rec = null; if (finalText.trim()) ask(finalText.trim()); };
  rec.start();
}
$('#mic').onclick = startMic;
$('#orb').onclick = startMic;
// Used only by the scripted demo recording (no microphone in a headless browser). Visibly labelled.
window.__demoDictate = async (text, cps = 26) => {
  showListening(true, true);
  $('#listening .lab').innerHTML = '<i></i> Listening · demo playback';
  for (let i = 1; i <= text.length; i++) { $('#live').textContent = text.slice(0, i); await new Promise((r) => setTimeout(r, 1000 / cps)); }
  await new Promise((r) => setTimeout(r, 500));
  showListening(false);
  $('#listening .lab').innerHTML = '<i></i> Listening';
  return ask(text);
};

// ------------------------------------------------------------------ assistant
const EXAMPLES = [
  ['EN', 'Invoice Cafe Morgenrot for 3.5 hours espresso machine repair at 70 an hour, plus 48 euros for a new pump gasket.'],
  ['DE', 'Rechnung an Kraemer Bakery: 2 Stunden Ofeninspektion, plus 25 Euro für die Anfahrt.'],
  ['EN', 'Who owes me money?'],
  ['EN', 'Remind Okafor Studio'],
];
$('#examples').innerHTML = EXAMPLES.map(([l, t], i) => `<button class="example" data-i="${i}"><span class="flag">${l}</span><span>${esc(t)}</span></button>`).join('');
$$('#examples .example').forEach((b) => (b.onclick = () => { $('#text').value = EXAMPLES[b.dataset.i][1]; $('#text').focus(); }));
const session = 's' + Math.random().toString(36).slice(2, 8);
function addMsg(role, html) {
  $('#hero').classList.add('hidden');
  const d = document.createElement('div');
  d.className = 'msg ' + role;
  d.innerHTML = html;
  $('#feed').append(d);
  requestAnimationFrame(() => { const b = $('#talk-body'); b.scrollTo({ top: b.scrollHeight, behavior: 'smooth' }); });
  return d;
}
let busy = false;
async function ask(text) {
  if (busy) return;
  busy = true;
  $('#send').disabled = true;
  $('#text').value = '';
  addMsg('user', esc(text));
  const pending = addMsg('agent', '<span class="typing"><i></i><i></i><i></i></span>');
  try {
    const j = await api('/api/agent', { method: 'POST', body: { text, session } });
    const chips = j.steps.map((s) => {
      const r = s.result || {};
      const bad = r.blocked || r.approval?.blocked || r.error;
      const tail = r.draft ? ` → ${r.draft.number}` : r.approval_id || r.approval?.approval_id ? ' → card' : bad ? ' → blocked' : r.count !== undefined ? ` → ${r.count}` : '';
      return `<span class="tool ${bad ? 'bad' : ''}">${icon('zap', 'sm')}${esc(s.tool)}${esc(tail)}</span>`;
    }).join('');
    pending.innerHTML = `${esc(j.reply)}${chips ? `<div class="tools">${chips}</div>` : ''}${j.notice ? `<div class="notice">${esc(j.notice)}</div>` : ''}<div class="meta">${icon('spark', 'sm')}${esc(j.engine.label)} · ${(j.ms / 1000).toFixed(1)} s</div>`;
    speak(j.reply, j.lang);
  } catch (e) {
    pending.innerHTML = `<span style="color:var(--red)">${icon('warn', 'sm')} ${esc(e.message)}</span>`;
    toast('err', 'Request failed', e.message);
  } finally {
    busy = false;
    $('#send').disabled = false;
    refresh();
  }
}
$('#ask').onsubmit = (e) => { e.preventDefault(); const t = $('#text').value.trim(); if (t) ask(t); };
$('#text').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#ask').requestSubmit(); } });

// ------------------------------------------------------------------ signature cards
let S = null;
const editing = new Set();
const ACTION = {
  send_invoice: { ic: 'send', cls: '', sub: 'PayPal Invoicing · POST /send' },
  send_reminder: { ic: 'bell', cls: 'remind', sub: 'PayPal Invoicing · POST /remind' },
  record_payment: { ic: 'cash', cls: 'pay', sub: 'PayPal Invoicing · POST /payments' },
  record_refund: { ic: 'undo', cls: 'refund', sub: 'PayPal Invoicing · POST /refunds' },
  cancel_invoice: { ic: 'ban', cls: 'cancel', sub: 'PayPal Invoicing · POST /cancel' },
};
function itemsTable(a, edit) {
  const cur = a.invoice.currency;
  if (edit) return `<table class="items"><tr><th>Item</th><th class="r" style="width:62px">Qty</th><th style="width:74px">Unit</th><th class="r" style="width:78px">Price</th><th></th></tr>
    ${a.invoice.items.map((i) => `<tr><td><input data-k="description" value="${esc(i.name)}"></td><td><input data-k="quantity" class="r" value="${i.quantity}"></td><td><select data-k="unit"><option value="HOURS" ${i.unit === 'HOURS' ? 'selected' : ''}>hours</option><option value="QUANTITY" ${i.unit !== 'HOURS' ? 'selected' : ''}>pcs</option></select></td><td><input data-k="unit_price" class="r" value="${i.unit_price.toFixed(2)}"></td><td class="x"><button class="iconbtn" style="width:26px;height:26px" data-del>${icon('x', 'sm')}</button></td></tr>`).join('')}</table>
    <button class="add-row" data-add>${icon('plus', 'sm')} Add line</button>`;
  return `<table class="items"><tr><th>Item</th><th class="r">Qty</th><th class="r">Unit price</th><th class="r">Amount</th></tr>
    ${a.invoice.items.map((i) => `<tr><td>${esc(i.name)}</td><td class="r num">${i.quantity}${i.unit === 'HOURS' ? ' h' : ''}</td><td class="r num">${money(Math.round(i.unit_price * 100), cur)}</td><td class="r num">${money(Math.round(i.quantity * i.unit_price * 100), cur)}</td></tr>`).join('')}</table>
    <div class="totals"><div><span>Net</span><span class="num">${money(a.invoice.subtotal_cents, cur)}</span></div><div><span>VAT ${S.business.taxRate}%</span><span class="num">${money(a.invoice.tax_cents, cur)}</span></div><div class="grand"><span>Total</span><span class="num">${money(a.invoice.total_cents, cur)}</span></div></div>`;
}
function cardHtml(a) {
  const meta = ACTION[a.action];
  const edit = editing.has(a.id);
  const body = a.action === 'send_invoice' ? itemsTable(a, edit)
    : `<div class="sub" style="color:var(--ink-2);font-size:13px">${esc(a.readback.text)}</div>${a.readback.message ? `<div class="quote">“${esc(a.readback.message)}”</div>` : ''}`;
  const flags = a.flags.map((f) => `<div class="flag ${f.level}">${icon(f.level === 'warn' ? 'warn' : 'info', 'sm')}<span>${esc(f.text)}</span></div>`).join('');
  return `<article class="card" data-id="${a.id}">
    <div class="card-h"><div class="card-ic ${meta.cls}">${icon(meta.ic)}</div><div><div class="card-t">${esc(a.readback.title)}</div><div class="card-s">${meta.sub}</div></div><span class="badge">Needs signature</span></div>
    <div class="card-b">
      <div class="who"><div class="avatar">${esc(initials(a.invoice.customer))}</div><div><b>${esc(a.invoice.customer)}</b><span>${esc(a.invoice.email)} · due ${day(a.invoice.due_date)}</span></div></div>
      ${body}${flags}
      <div class="fp">${icon('lock', 'sm')} fingerprint ${esc(a.fingerprint)} · ${esc(a.invoice.id)}</div>
    </div>
    <div class="card-f">${edit
      ? `<button class="btn" data-cancel-edit>Cancel</button><button class="btn primary" data-save>${icon('check', 'sm')} Save draft in PayPal</button>`
      : `<button class="btn danger" data-reject>${icon('x', 'sm')} Reject</button>${a.action === 'send_invoice' ? `<button class="btn" data-edit>${icon('edit', 'sm')} Edit</button>` : ''}<button class="btn primary" data-approve>${icon('check', 'sm')} ${esc(a.readback.verb || 'Approve')}</button>`}</div>
  </article>`;
}
function renderApprovals() {
  const pend = S.approvals.filter((a) => a.status === 'pending');
  const c = $('#pending-count');
  c.textContent = pend.length;
  c.classList.toggle('zero', !pend.length);
  $('#approvals').innerHTML = pend.length ? pend.map(cardHtml).join('')
    : `<div class="empty"><div class="ill">${icon('shield', 'lg')}</div><b>Nothing waiting for you</b>Describe a finished job on the left. Drafts land here for your signature.</div>`;
  $$('#approvals .card').forEach((el) => {
    const id = el.dataset.id;
    const a = pend.find((x) => x.id === id);
    el.querySelector('[data-approve]')?.addEventListener('click', (e) => decide(a, 'approve', e.currentTarget));
    el.querySelector('[data-reject]')?.addEventListener('click', (e) => decide(a, 'reject', e.currentTarget));
    el.querySelector('[data-edit]')?.addEventListener('click', () => { editing.add(id); renderApprovals(); });
    el.querySelector('[data-cancel-edit]')?.addEventListener('click', () => { editing.delete(id); renderApprovals(); });
    el.querySelector('[data-add]')?.addEventListener('click', () => { a.invoice.items.push({ name: '', quantity: 1, unit_price: 0, unit: 'QUANTITY' }); collect(el, a, true); renderApprovals(); });
    el.querySelectorAll('[data-del]').forEach((b, i) => b.addEventListener('click', () => { collect(el, a, true); a.invoice.items.splice(i, 1); renderApprovals(); }));
    el.querySelector('[data-save]')?.addEventListener('click', async (e) => {
      const items = collect(el, a);
      e.currentTarget.disabled = true;
      try {
        await api(`/api/invoices/${a.invoice.id}/edit`, { method: 'POST', body: { items } });
        editing.delete(id);
        toast('ok', 'Draft updated in PayPal', 'PUT /v2/invoicing/invoices · a fresh card replaces the old one');
      } catch (err) { toast('err', 'Could not update draft', err.message); e.currentTarget.disabled = false; }
      refresh();
    });
  });
  const done = S.approvals.filter((a) => a.status !== 'pending').slice(0, 10);
  $('#history').innerHTML = done.map((a) => `<div class="hist">${icon(ACTION[a.action].ic, 'sm')}<span class="t">${esc(a.readback.title)} · ${esc(a.invoice.customer)}${a.error ? `<span class="err">${esc(a.error)}</span>` : ''}</span><span class="st st-${a.status}">${a.status}</span></div>`).join('') || '<div class="sub">No decisions yet.</div>';
}
function collect(el, a, keep) {
  const rows = el.querySelectorAll('table.items tr');
  const items = [];
  rows.forEach((tr, i) => {
    if (!i) return;
    const v = (k) => tr.querySelector(`[data-k="${k}"]`)?.value;
    items.push({ description: v('description'), quantity: Number(String(v('quantity')).replace(',', '.')), unit_price: Number(String(v('unit_price')).replace(',', '.')), unit: v('unit') });
  });
  if (keep) a.invoice.items = items.map((i) => ({ name: i.description, quantity: i.quantity, unit_price: i.unit_price, unit: i.unit }));
  return items;
}
async function decide(a, decision, btn) {
  btn.disabled = true;
  btn.innerHTML = decision === 'approve' ? `<span class="typing"><i></i><i></i><i></i></span> Calling PayPal` : 'Rejecting…';
  try {
    const j = await api(`/api/approvals/${a.id}`, { method: 'POST', body: { decision, fingerprint: a.fingerprint } });
    const mode = S.mode.paypal === 'sandbox' ? 'PayPal sandbox' : 'PayPal MOCK';
    if (j.status === 'executed') toast('ok', { send_invoice: `Invoice ${j.invoice.number} sent`, send_reminder: `Reminder sent to ${j.invoice.customer}`, record_payment: `${j.invoice.number} marked as paid`, record_refund: `Refund recorded on ${j.invoice.number}`, cancel_invoice: `${j.invoice.number} cancelled` }[j.action], `${mode} accepted the call · idempotency key ${j.id}`);
    if (j.status === 'failed') toast('err', 'Not executed', j.error, 8000);
    if (j.status === 'rejected') toast('info', 'Rejected', 'Nothing was sent to PayPal.');
  } catch (e) { toast('err', 'Could not decide', e.message); }
  refresh();
}

// ------------------------------------------------------------------ dashboard
let filter = 'all';
let flashId = null;
const shown = {};
function countUp(el, cents, cur) {
  const from = shown[el.id] ?? cents;
  shown[el.id] = cents;
  if (from === cents) { el.textContent = money(cents, cur); return; }
  const t0 = performance.now();
  const step = (t) => { const k = Math.min(1, (t - t0) / 900); const e = 1 - Math.pow(1 - k, 3); el.textContent = money(Math.round(from + (cents - from) * e), cur); if (k < 1) requestAnimationFrame(step); };
  requestAnimationFrame(step);
}
function renderDash() {
  const s = S.summary, cur = s.currency;
  countUp($('#k-out'), s.outstanding_cents, cur);
  countUp($('#k-over'), s.overdue_cents, cur);
  countUp($('#k-paid'), s.paid_cents, cur);
  $('#k-out-d').textContent = `${s.counts.open} open invoice${s.counts.open === 1 ? '' : 's'}`;
  $('#k-over-d').textContent = s.counts.overdue ? `${s.counts.overdue} past due date` : 'nothing overdue';
  $('#k-paid-d').textContent = `${s.counts.paid} paid in full`;
  const wk = S.analytics.weeks;
  const max = Math.max(1, ...wk.map((w) => w.paid_cents));
  $('#bars').innerHTML = wk.map((w, i) => `<div class="bar ${i === wk.length - 1 ? 'cur' : ''}" title="${money(w.paid_cents, cur)} collected ${w.from} – ${w.to}"><div class="col" style="height:${Math.max(3, (w.paid_cents / max) * 82)}px"></div><small>${i === wk.length - 1 ? 'now' : w.from.slice(8) + '/' + Number(w.from.slice(5, 7))}</small></div>`).join('');
  const ag = S.analytics.aging;
  const amax = Math.max(1, ...ag.map((a) => a.cents));
  const colors = ['var(--blue)', '#f2a43a', 'var(--orange)', 'var(--red)'];
  $('#aging').innerHTML = ag.map((a, i) => `<div class="row"><span>${a.label}</span><div class="track"><div class="fill" style="width:${(a.cents / amax) * 100}%;background:${colors[i]}"></div></div><b class="num">${money(a.cents, cur)}</b></div>`).join('');
  const f = { all: () => true, open: (i) => ['SENT', 'UNPAID', 'PARTIALLY_PAID'].includes(i.status), overdue: (i) => i.overdue, paid: (i) => i.paid_cents > 0, draft: (i) => i.status === 'DRAFT' }[filter];
  const list = S.invoices.filter(f);
  $('#invoices').innerHTML = list.length ? list.map((i) => {
    const acts = [];
    if (['SENT', 'UNPAID', 'PARTIALLY_PAID'].includes(i.status)) acts.push(['remind', 'bell', 'Propose reminder'], ['mark_paid', 'cash', 'Mark as paid (cash/transfer)'], ['cancel', 'ban', 'Propose cancel']);
    if (i.paid_cents > i.refunded_cents) acts.push(['refund', 'undo', 'Propose refund']);
    if (i.status === 'DRAFT') acts.push(['send', 'send', 'Queue for sending'], ['discard', 'trash', 'Discard draft']);
    return `<div class="inv ${i.id === flashId ? 'flash' : ''}" data-id="${i.id}">
      <div class="avatar" style="width:32px;height:32px;font-size:12px">${esc(initials(i.customer))}</div>
      <div style="min-width:0"><div class="c">${esc(i.customer)}</div><div class="n">${esc(i.number)} · ${i.overdue ? `<b style="color:var(--orange)">${i.days_overdue} days overdue</b>` : `due ${day(i.due_date)}`}${i.meta?.transcript ? ` · ${icon('mic', 'sm')}` : ''}</div></div>
      <div class="row-actions">${acts.map(([a, ic, t]) => `<button title="${t}" data-act="${a}">${icon(ic, 'sm')}</button>`).join('')}<button title="Preview invoice" data-act="open">${icon('eye', 'sm')}</button></div>
      <div class="a num">${money(i.total_cents, i.currency)}<small><span class="st st-${i.display_status}">${i.display_status.replace(/_/g, ' ')}</span></small></div>
    </div>`;
  }).join('') : `<div class="empty"><div class="ill">${icon('file', 'lg')}</div><b>No invoices here</b>Try another filter, or say a job on the left.</div>`;
  $$('#invoices .inv').forEach((row) => {
    row.addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]');
      const id = row.dataset.id;
      if (!b || b.dataset.act === 'open') return openInvoice(id);
      e.stopPropagation();
      rowAction(id, b.dataset.act);
    });
  });
}
async function rowAction(id, act) {
  try {
    if (act === 'discard') { await api(`/api/invoices/${id}`, { method: 'DELETE' }); toast('info', 'Draft discarded', 'DELETE /v2/invoicing/invoices'); return refresh(); }
    const inv = S.invoices.find((i) => i.id === id);
    let body = { action: act };
    if (act === 'mark_paid') body.method = 'BANK_TRANSFER';
    if (act === 'refund') { const v = prompt(`Refund amount for ${inv.number} (max ${money(inv.paid_cents - inv.refunded_cents, inv.currency)})`, ((inv.paid_cents - inv.refunded_cents) / 100).toFixed(2)); if (!v) return; body.amount = Number(v.replace(',', '.')); }
    const r = await api(`/api/invoices/${id}/propose`, { method: 'POST', body });
    if (r.blocked) toast('err', 'Blocked by a guardrail', r.reasons[0], 7000);
    else if (r.error) toast('err', 'Not possible', r.error);
    else toast('info', 'Card added for your signature', 'Review it in the middle column.');
  } catch (e) { toast('err', 'Action failed', e.message); }
  refresh();
}
$$('#filters button').forEach((b) => (b.onclick = () => { filter = b.dataset.f; $$('#filters button').forEach((x) => x.classList.toggle('on', x === b)); renderDash(); }));

// ------------------------------------------------------------------ invoice drawer
async function openInvoice(id) {
  const { invoice: i, timeline } = await api(`/api/invoices/${id}`);
  const cur = i.currency;
  const mock = S.mode.paypal === 'mock';
  const tlLabel = { 'invoice.draft_created': 'Draft created in PayPal', 'invoice.draft_updated': 'Draft edited (PUT)', 'proposal.created': 'Card proposed', 'proposal.approved': 'Approved by owner', 'proposal.rejected': 'Rejected by owner', 'executed.send_invoice': 'Sent via PayPal', 'executed.send_reminder': 'Reminder sent', 'executed.record_payment': 'Payment recorded', 'executed.record_refund': 'Refund recorded', 'executed.cancel_invoice': 'Cancelled', 'webhook.received': 'Webhook: INVOICE.PAID', 'execution.failed': 'PayPal call failed', 'execution.blocked': 'Blocked at execution' };
  const events = timeline.filter((t) => tlLabel[t.action]);
  const root = $('#drawer-root');
  root.innerHTML = `<div class="scrim" data-close></div><aside class="drawer" role="dialog" aria-label="Invoice ${esc(i.number)}">
    <div class="drawer-h"><div class="card-ic">${icon('file')}</div><div><h3>${esc(i.number)} · ${esc(i.customer)}</h3><div class="sub">${esc(i.id)}</div></div><span class="st st-${i.display_status}" style="margin-left:auto">${i.display_status.replace(/_/g, ' ')}</span><button class="iconbtn" data-close>${icon('x')}</button></div>
    <div class="drawer-b">
      <div class="paper">
        <div class="ph"><div><b>${esc(S.business.name)}</b><div style="opacity:.75;font-size:11px;margin-top:3px">Invoice via PayPal</div>${mock ? '<div class="mockmark">MOCK MODE · demo invoice</div>' : ''}</div><div><div class="inv-t">INVOICE</div><div style="opacity:.75;text-align:right">${esc(i.number)}</div></div></div>
        <div class="pb">
          <div class="meta"><div><div class="lbl">Bill to</div><b style="font-size:13px">${esc(i.customer)}</b><div>${esc(i.contact || '')}</div><div style="color:#5d6b89">${esc(i.email)}</div></div>
          <div style="text-align:right"><div class="lbl">Invoice date</div>${esc(i.invoice_date)}<div class="lbl" style="margin-top:6px">Due date</div>${esc(i.due_date)}</div></div>
          <table><tr><th>Description</th><th class="r">Qty</th><th class="r">Unit price</th><th class="r">Amount</th></tr>
          ${i.items.map((it) => `<tr><td>${esc(it.name)}</td><td class="r">${it.quantity}${it.unit === 'HOURS' ? ' h' : ''}</td><td class="r">${money(Math.round(it.unit_price * 100), cur)}</td><td class="r">${money(Math.round(it.quantity * it.unit_price * 100), cur)}</td></tr>`).join('')}</table>
          <div class="ptot"><div><span>Net</span><span>${money(i.subtotal_cents, cur)}</span></div><div><span>VAT ${S.business.taxRate}%</span><span>${money(i.tax_cents, cur)}</span></div>
          ${i.paid_cents ? `<div><span>Paid</span><span>− ${money(i.paid_cents, cur)}</span></div>` : ''}${i.refunded_cents ? `<div><span>Refunded</span><span>${money(i.refunded_cents, cur)}</span></div>` : ''}
          <div class="pdue" style="display:flex;justify-content:space-between"><span>${i.paid_cents ? 'Amount due' : 'Total'}</span><span>${money(i.paid_cents ? i.due_cents : i.total_cents, cur)}</span></div></div>
          <div class="pay"><b>Pay online with PayPal, Pay Later or card</b><br>${esc(i.status === 'DRAFT' ? 'Link becomes active once the invoice is sent.' : (i.payer_url || ''))}</div>
        </div>
      </div>
      <div class="side">
        <h5>Actions</h5>
        <a class="btn" href="/api/invoices/${i.id}/pdf" target="_blank">${icon('dl', 'sm')} Download PDF</a>
        ${i.status !== 'DRAFT' && i.payer_url ? `<a class="btn" href="${esc(i.payer_url)}" target="_blank">${icon('ext', 'sm')} Customer pay page</a>` : ''}
        <button class="btn" onclick="window.print()">${icon('file', 'sm')} Print</button>
        <h5 style="margin-top:16px">Timeline</h5>
        <ul class="tl">${i.created_at ? `<li>Created<small>${when(i.created_at)}</small></li>` : ''}${i.sent_at ? `<li>Sent to customer<small>${when(i.sent_at)}</small></li>` : ''}
        ${events.map((e) => `<li>${esc(tlLabel[e.action])}<small>${when(e.ts)} · ${esc(e.actor)}</small></li>`).join('')}
        ${i.payments.map((p) => `<li>Payment ${money(p.cents, cur)} · ${esc((p.method || '').replace(/_/g, ' ').toLowerCase())}<small>${esc(p.date)}</small></li>`).join('')}
        ${i.refunds.map((p) => `<li>Refund ${money(p.cents, cur)}<small>${esc(p.date)}</small></li>`).join('')}</ul>
        ${i.meta?.transcript ? `<h5 style="margin-top:16px">Dictated</h5><div class="quote" style="border-color:var(--blue);background:var(--sky)">“${esc(i.meta.transcript)}”</div>` : ''}
      </div>
    </div></aside>`;
  $$('[data-close]', root).forEach((el) => (el.onclick = () => (root.innerHTML = '')));
}
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('#drawer-root').innerHTML = ''; });

// ------------------------------------------------------------------ activity
let sub = 'trace';
let showReads = false;
$$('.tab').forEach((t) => (t.onclick = () => { $$('.tab').forEach((x) => x.classList.toggle('on', x === t)); $('#tab-overview').classList.toggle('hidden', t.dataset.tab !== 'overview'); $('#tab-activity').classList.toggle('hidden', t.dataset.tab !== 'activity'); if (t.dataset.tab === 'activity') renderActivity(); }));
$$('.subtabs button').forEach((b) => (b.onclick = () => { sub = b.dataset.s; $$('.subtabs button').forEach((x) => x.classList.toggle('on', x === b)); renderActivity(); }));
async function renderActivity() {
  const el = $('#activity');
  if (sub === 'trace') {
    const all = await api('/api/trace');
    const t = showReads ? all : all.filter((x) => x.method !== 'GET');
    el.innerHTML = `<div class="list-h" style="margin-top:0"><span class="sub">${all.length} calls · ${all.length - t.length} reads hidden</span><div class="filters"><button id="reads" class="${showReads ? 'on' : ''}">Show reads</button></div></div>` + (t.length ? t.map((x) => `<div class="trace-row"><span class="method m-${x.method}">${x.method}</span><span class="mono" title="debug_id ${esc(x.debugId || '')}">${esc(x.path)}${x.error ? ` <span class="ko">${esc(x.error)}</span>` : ''}</span><span class="${x.status < 300 ? 'ok' : 'ko'}">${x.status}</span><span class="sub">${x.ms} ms</span></div>`).join('') : `<div class="empty"><b>No PayPal calls yet</b>Every Invoicing API request appears here with status and latency.</div>`);
    $('#reads').onclick = () => { showReads = !showReads; renderActivity(); };
  } else if (sub === 'audit') {
    const a = await api('/api/audit');
    el.innerHTML = `<div class="chainok" style="${a.verify.ok ? '' : 'background:var(--red-soft);color:var(--red)'}">${icon(a.verify.ok ? 'shield' : 'warn', 'sm')} ${a.verify.ok ? `SHA-256 chain verified · ${a.verify.length} entries · head ${a.verify.head.slice(0, 12)}…` : `Chain broken at #${a.verify.brokenAt}`}</div>` +
      a.entries.map((e) => `<div class="audit-row"><span class="sub">#${e.seq}</span><span><b>${esc(e.actor)}</b></span><span class="mono">${esc(e.action)}</span><span class="mono sub">${esc(e.hash.slice(0, 10))}</span></div>`).join('');
  } else {
    const ev = await api('/api/automation/events');
    el.innerHTML = `<div class="intro">${icon('zap')}<span>Signed JSON events for n8n or any webhook (<span class="mono">AUTOMATION_WEBHOOK_URL</span>). ${S.automation.configured ? 'Delivery is <b>on</b>.' : 'Delivery is off; events are shown here.'} See <span class="mono">n8n/</span> for ready-made workflows.</span></div>` +
      (ev.length ? ev.map((e) => `<div class="evt-row"><span class="mono"><b>${esc(e.type)}</b></span><span class="mono sub">${esc(JSON.stringify(e.data).slice(0, 80))}</span><span class="sub">${new Date(e.created).toLocaleTimeString('en-GB')}</span></div>`).join('') : '<div class="empty"><b>No events yet</b></div>');
  }
}

// ------------------------------------------------------------------ state + live events
async function refresh() {
  try { S = await api('/api/state'); } catch (e) { toast('err', 'Server unreachable', e.message); return; }
  const pp = $('#p-paypal');
  pp.className = 'pill ' + (S.mode.paypal === 'sandbox' ? 'live' : 'mock');
  pp.innerHTML = `<span class="dot"></span>${S.mode.paypal === 'sandbox' ? 'PayPal sandbox · live REST' : 'PayPal MOCK · simulated API'}`;
  $('#p-ai').innerHTML = `<span class="dot"></span>${esc(S.mode.ai.label)}`;
  $('#engine-label').textContent = '';
  $('#reset').classList.toggle('hidden', S.mode.paypal !== 'mock');
  renderApprovals();
  renderDash();
  api('/api/audit').then((a) => { $('#p-chain').innerHTML = `<span class="dot"></span>${a.verify.ok ? `Audit chain ✓ ${a.verify.length}` : 'Audit chain broken'}`; });
  if (!$('#tab-activity').classList.contains('hidden')) renderActivity();
}
let rT;
const soon = () => { clearTimeout(rT); rT = setTimeout(refresh, 120); };
const es = new EventSource('/api/events');
es.addEventListener('invoices', soon);
es.addEventListener('approval', (e) => { soon(); const a = JSON.parse(e.data); if (a.status === 'pending' && a.readback?.speech) speak(a.readback.speech, 'en'); });
es.addEventListener('blocked', (e) => { const b = JSON.parse(e.data); toast('err', 'Blocked by a guardrail', b.reasons[0], 7000); soon(); });
es.addEventListener('trace', () => { if (!$('#tab-activity').classList.contains('hidden') && sub === 'trace') renderActivity(); });
es.addEventListener('payment', (e) => {
  const p = JSON.parse(e.data);
  flashId = p.invoice_id;
  toast('money', `${p.customer} just paid ${p.amount}`, `${p.number} · webhook INVOICING.INVOICE.PAID`, 7000);
  speak(`${p.customer} just paid ${p.amount}.`, 'en');
  $('#kpi-paid').classList.add('flash');
  refresh().then(() => setTimeout(() => { flashId = null; $('#kpi-paid').classList.remove('flash'); renderDash(); }, 3500));
});
$('#reset').onclick = async () => { await api('/api/demo/reset', { method: 'POST' }); $('#feed').innerHTML = ''; $('#hero').classList.remove('hidden'); toast('info', 'Demo data restored', 'Fictional customers and amounts'); refresh(); };
applyPrefs();
refresh();
})();
