'use strict';
// Dependency-free PDF 1.4 writer for invoices (A4, Helvetica, WinAnsiEncoding so € and umlauts work).
const { fmt, toCents } = require('./money');

// Helvetica glyph widths (1/1000 em) for ASCII 32..126, from the standard Adobe AFM metrics.
const W = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584];
const WIN = { '€': 0x80, '–': 0x96, '—': 0x97, '·': 0xb7, '×': 0xd7, 'ä': 0xe4, 'ö': 0xf6, 'ü': 0xfc, 'Ä': 0xc4, 'Ö': 0xd6, 'Ü': 0xdc, 'ß': 0xdf, 'é': 0xe9, 'è': 0xe8, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95 };
const enc = (s) => Array.from(String(s)).map((ch) => {
  const c = ch.charCodeAt(0);
  const b = WIN[ch] ?? (c >= 32 && c < 127 ? c : c >= 160 && c < 256 ? c : 63);
  if (b === 40 || b === 41 || b === 92) return '\\' + String.fromCharCode(b);
  return b < 127 ? String.fromCharCode(b) : '\\' + b.toString(8).padStart(3, '0');
}).join('');
const width = (s, size, bold) => Array.from(String(s)).reduce((w, ch) => { const c = ch.charCodeAt(0); return w + (c >= 32 && c < 127 ? W[c - 32] : 556); }, 0) * size / 1000 * (bold ? 1.06 : 1);
const rgb = (hex) => [1, 3, 5].map((i) => (parseInt(hex.slice(i, i + 2), 16) / 255).toFixed(3)).join(' ');

function invoicePdf(inv, business, { mock = false, payerUrl = '' } = {}) {
  const ops = [];
  const H = 842, L = 50, R = 545;
  const text = (x, y, s, { size = 10, bold = false, color = '#0b1b3f', align = 'left' } = {}) => {
    const w = width(s, size, bold);
    const xx = align === 'right' ? x - w : align === 'center' ? x - w / 2 : x;
    ops.push(`BT ${rgb(color)} rg /${bold ? 'F2' : 'F1'} ${size} Tf ${xx.toFixed(1)} ${(H - y).toFixed(1)} Td (${enc(s)}) Tj ET`);
  };
  const rect = (x, y, w, h, color) => ops.push(`${rgb(color)} rg ${x} ${H - y - h} ${w} ${h} re f`);
  const line = (x1, y1, x2, y2, color = '#dfe5ef', wdt = 0.8) => ops.push(`${rgb(color)} RG ${wdt} w ${x1} ${H - y1} m ${x2} ${H - y2} l S`);
  const cur = inv.currency;
  const money = (c) => fmt(c, cur);

  rect(0, 0, 595, 118, '#003087');
  rect(0, 118, 595, 5, '#0070e0');
  text(L, 52, business.name, { size: 20, bold: true, color: '#ffffff' });
  text(L, 74, 'Invoice created with SayPaid · payable via PayPal', { size: 10, color: '#c9d6ee' });
  text(R, 52, 'INVOICE', { size: 24, bold: true, color: '#ffffff', align: 'right' });
  text(R, 74, inv.number, { size: 11, color: '#c9d6ee', align: 'right' });
  if (mock) { rect(L, 92, 210, 16, '#ffc439'); text(L + 6, 104, 'MOCK MODE · demo invoice, not a real bill', { size: 8, bold: true, color: '#3b2a00' }); }

  text(L, 160, 'BILL TO', { size: 8, bold: true, color: '#6b7a99' });
  text(L, 176, inv.customer, { size: 12, bold: true });
  if (inv.contact && inv.contact !== inv.customer) text(L, 191, inv.contact, { size: 10, color: '#3b4a6b' });
  text(L, 205, inv.email || '', { size: 10, color: '#3b4a6b' });
  const meta = [['Invoice date', inv.invoice_date], ['Due date', inv.due_date], ['Status', inv.display_status.replace(/_/g, ' ')], ['PayPal ID', inv.id]];
  meta.forEach(([k, v], i) => { text(330, 160 + i * 16, k, { size: 9, color: '#6b7a99' }); text(R, 160 + i * 16, v || '–', { size: i === 3 ? 8 : 9, bold: true, align: 'right' }); });

  let y = 250;
  rect(L, y, R - L, 24, '#eef3fb');
  text(L + 10, y + 16, 'Description', { size: 9, bold: true, color: '#3b4a6b' });
  text(370, y + 16, 'Qty', { size: 9, bold: true, color: '#3b4a6b', align: 'right' });
  text(450, y + 16, 'Unit price', { size: 9, bold: true, color: '#3b4a6b', align: 'right' });
  text(R - 10, y + 16, 'Amount', { size: 9, bold: true, color: '#3b4a6b', align: 'right' });
  y += 24;
  for (const it of inv.items) {
    y += 24;
    const amt = Math.round(it.quantity * toCents(it.unit_price));
    let name = it.name;
    while (width(name, 10) > 280) name = name.slice(0, -2);
    text(L + 10, y - 8, name + (name !== it.name ? '…' : ''), { size: 10 });
    text(370, y - 8, `${it.quantity}${it.unit === 'HOURS' ? ' h' : ''}`, { size: 10, align: 'right' });
    text(450, y - 8, money(toCents(it.unit_price)), { size: 10, align: 'right' });
    text(R - 10, y - 8, money(amt), { size: 10, align: 'right' });
    line(L, y, R, y);
  }
  y += 26;
  const totals = [['Subtotal (net)', money(inv.subtotal_cents)], [`VAT ${business.taxRate}%`, money(inv.tax_cents)]];
  if (inv.paid_cents) totals.push(['Paid', '− ' + money(inv.paid_cents)]);
  if (inv.refunded_cents) totals.push(['Refunded', money(inv.refunded_cents)]);
  totals.forEach(([k, v]) => { text(450, y, k, { size: 10, color: '#3b4a6b', align: 'right' }); text(R - 10, y, v, { size: 10, align: 'right' }); y += 18; });
  rect(330, y - 8, R - 330, 34, '#003087');
  text(345, y + 14, inv.paid_cents ? 'Amount due' : 'Total due', { size: 11, bold: true, color: '#ffffff' });
  text(R - 10, y + 14, money(inv.paid_cents ? inv.due_cents : inv.total_cents), { size: 14, bold: true, color: '#ffffff', align: 'right' });
  y += 70;
  if (inv.note) { text(L, y, 'NOTE', { size: 8, bold: true, color: '#6b7a99' }); text(L, y + 15, inv.note.slice(0, 95), { size: 10 }); y += 40; }
  rect(L, y, R - L, 54, '#fff8e1');
  text(L + 14, y + 22, 'Pay online with PayPal, Pay Later or card', { size: 11, bold: true, color: '#3b2a00' });
  text(L + 14, y + 40, (payerUrl || inv.payer_url || '').slice(0, 90), { size: 9, color: '#6b5200' });
  line(L, 790, R, 790);
  text(L, 806, `${business.name} · Prices in ${cur} · VAT ${business.taxRate}%`, { size: 8, color: '#6b7a99' });
  text(R, 806, 'Generated by SayPaid (open source, MIT)', { size: 8, color: '#6b7a99', align: 'right' });

  const content = ops.join('\n');
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
    `<< /Title (${enc('Invoice ' + inv.number)}) /Producer (SayPaid) >>`,
  ];
  let out = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
  const offsets = [];
  objs.forEach((o, i) => { offsets.push(Buffer.byteLength(out, 'latin1')); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('');
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info 7 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

module.exports = { invoicePdf };
