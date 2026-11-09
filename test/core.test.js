'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { invoiceTotals } = require('../lib/money');
const { parseInvoice, offlinePlan, detectLang, normalizeNumbers } = require('../lib/offline-agent');
const { AuditLog } = require('../lib/audit');
const { truthGuard } = require('../lib/agent');
const cfg = { business: { hourlyRate: 65 } };

test('money math is exact in cents (19% VAT)', () => {
  assert.deepStrictEqual(invoiceTotals([{ quantity: 3.5, unit_price: 70 }, { quantity: 1, unit_price: 48 }], 19), { subtotal: 29300, tax: 5567, total: 34867 });
  assert.deepStrictEqual(invoiceTotals([{ quantity: 0.1, unit_price: 0.1 }], 19).subtotal, 1);
});

test('English dictation becomes line items', () => {
  const r = parseInvoice('Invoice Cafe Morgenrot for three and a half hours of espresso machine repair at 70 an hour, plus 48 euros for a new pump gasket, due in 10 days.', cfg);
  assert.strictEqual(r.args.customer, 'Cafe Morgenrot');
  assert.deepStrictEqual(r.args.items[0], { description: 'Espresso machine repair', quantity: 3.5, unit_price: 70, unit: 'HOURS' });
  assert.deepStrictEqual(r.args.items[1], { description: 'Pump gasket', quantity: 1, unit_price: 48, unit: 'QUANTITY' });
  assert.strictEqual(r.args.due_in_days, 10);
});

test('German dictation becomes line items (Zahlwörter, default hourly rate)', () => {
  const r = offlinePlan('Rechnung an Kraemer Bakery: zweieinhalb Stunden Ofenreparatur zu 70 Euro pro Stunde, plus 35 Euro für ein Thermostat.', cfg);
  assert.strictEqual(r.lang, 'de');
  assert.strictEqual(r.tool, 'draft_invoice');
  assert.deepStrictEqual(r.args.items, [{ description: 'Ofenreparatur', quantity: 2.5, unit_price: 70, unit: 'HOURS' }, { description: 'Thermostat', quantity: 1, unit_price: 35, unit: 'QUANTITY' }]);
  const d = offlinePlan('Rechnung an Kraemer Bakery: 2 Stunden Ofeninspektion, plus 25 Euro für die Anfahrt.', cfg);
  assert.strictEqual(d.args.items[0].unit_price, 65, 'falls back to the configured hourly rate');
  assert.strictEqual(normalizeNumbers('3,5 Stunden'), '3.5 Stunden');
});

test('offline intents in both languages', () => {
  const cases = [
    ['Who owes me money?', 'list_invoices', 'en'], ['Wer schuldet mir Geld?', 'list_invoices', 'de'],
    ['Remind Okafor Studio', 'propose_reminder', 'en'], ['Erinnere Okafor Studio', 'propose_reminder', 'de'],
    ['Okafor Studio paid cash', 'propose_record_payment', 'en'], ['Okafor Studio hat bar bezahlt', 'propose_record_payment', 'de'],
    ['Refund 20 euros to Kraemer Bakery', 'propose_refund', 'en'], ['Erstatte 20 Euro an Kraemer Bakery', 'propose_refund', 'de'],
    ['Cancel the Hotel Seeblick invoice', 'propose_cancel', 'en'], ['Storniere die Rechnung von Hotel Seeblick', 'propose_cancel', 'de'],
    ['How am I doing?', 'get_summary', 'en'],
  ];
  for (const [t, tool, lang] of cases) {
    const r = offlinePlan(t, cfg);
    assert.strictEqual(r.tool, tool, t);
    assert.strictEqual(r.lang, lang, t);
  }
  assert.strictEqual(offlinePlan('Storniere die Rechnung von Hotel Seeblick', cfg).args.customer, 'Hotel Seeblick');
  assert.ok(offlinePlan('hello there', cfg).help);
  assert.strictEqual(detectLang('Bitte eine Übersicht'), 'de');
});

test('audit log is hash chained and detects tampering', () => {
  const a = new AuditLog(fs.mkdtempSync(path.join(os.tmpdir(), 'audit-')));
  a.append('human', 'x', { n: 1 });
  a.append('agent', 'y', { n: 2 });
  assert.ok(a.verify().ok);
  a.entries[0].details.n = 999;
  assert.strictEqual(a.verify().ok, false);
});

test('truth guard: the model cannot claim actions the tools did not take', () => {
  assert.match(truthGuard('Reminder queued, waiting for your approval.', [{ tool: 'propose_reminder', result: { blocked: true, reasons: ['A reminder was already sent today.'] } }]), /^Blocked by a guardrail: A reminder was already sent today/);
  assert.match(truthGuard('Invoice sent!', []), /did not take any action/);
  assert.match(truthGuard('It is waiting for your approval.', [{ tool: 'list_invoices', result: { count: 0 } }]), /^No action was queued/);
  assert.strictEqual(truthGuard('Okafor Studio owes €392.46.', [{ tool: 'list_invoices', result: { count: 1 } }]), 'Okafor Studio owes €392.46.');
});
