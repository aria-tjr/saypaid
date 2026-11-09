'use strict';
// The mock must behave like PayPal Invoicing v2 so the same code path works against the sandbox.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MockPayPal } = require('../lib/paypal-mock');
const { buildInvoicePayload } = require('../lib/invoice');
const { DEMO_CUSTOMERS } = require('../lib/store');

const business = { name: 'Demo Repair Workshop', email: 'owner@example.com', currency: 'EUR', taxRate: 19, hourlyRate: 65, paymentTermDays: 14 };
const mk = () => new MockPayPal(fs.mkdtempSync(path.join(os.tmpdir(), 'mock-')), () => {}, { latencyMs: 0 });
const cust = Object.values(DEMO_CUSTOMERS)[0];
const payload = (number, items = [{ description: 'Repair', quantity: 2, unit_price: 65, unit: 'HOURS' }]) => buildInvoicePayload({ customer: cust, items, invoice_number: number }, business);

test('draft has PayPal-shaped ids, links, breakdown and status', async () => {
  const pp = mk();
  const invoice_number = await pp.nextInvoiceNumber();
  assert.match(invoice_number, /^SP-\d+$/);
  const inv = await pp.createDraft(payload(invoice_number));
  assert.match(inv.id, /^INV2(-[A-Z0-9]{4}){4}$/);
  assert.strictEqual(inv.status, 'DRAFT');
  assert.strictEqual(inv.amount.value, '154.70');
  assert.strictEqual(inv.amount.breakdown.item_total.value, '130.00');
  assert.strictEqual(inv.amount.breakdown.tax_total.value, '24.70');
  assert.ok(inv.links.some((l) => l.rel === 'send' && l.method === 'POST'));
  assert.match(inv.items[0].id, /^ITEM-/);
});

test('validation errors use PayPal error shape', async () => {
  const pp = mk();
  const bad = payload('X-1');
  delete bad.detail.currency_code;
  await assert.rejects(pp.createDraft(bad), (e) => e.status === 400 && e.paypal.name === 'INVALID_REQUEST' && e.paypal.details.some((d) => d.issue === 'MISSING_REQUIRED_PARAMETER'));
  await pp.createDraft(payload('DUP-1'));
  await assert.rejects(pp.createDraft(payload('DUP-1')), (e) => e.paypal.details[0].issue === 'DUPLICATE_INVOICE_NUMBER' && /^[0-9a-f]+$/.test(e.paypal.debug_id));
});

test('idempotency: same PayPal-Request-Id returns the same draft', async () => {
  const pp = mk();
  const a = await pp.createDraft(payload('IDEM-1'), 'req-123');
  const b = await pp.createDraft(payload('IDEM-1'), 'req-123');
  assert.strictEqual(a.id, b.id);
  assert.strictEqual((await pp.list()).length, 1);
});

test('lifecycle: update only while DRAFT, send, remind, pay, refund', async () => {
  const pp = mk();
  const inv = await pp.createDraft(payload('LC-1'));
  const upd = await pp.update(inv.id, payload('LC-1', [{ description: 'Repair', quantity: 3, unit_price: 65, unit: 'HOURS' }]));
  assert.strictEqual(upd.amount.value, '232.05');
  await pp.send(inv.id);
  assert.strictEqual((await pp.get(inv.id)).status, 'SENT');
  await assert.rejects(pp.update(inv.id, payload('LC-1')), (e) => e.status === 422);
  await pp.remind(inv.id);
  const evt = pp.simulatePayerPayment(inv.id, { method: 'PAYPAL' });
  assert.strictEqual(evt.event_type, 'INVOICING.INVOICE.PAID');
  assert.strictEqual(evt.resource.invoice.status, 'PAID');
  assert.throws(() => pp.simulatePayerPayment(inv.id), (e) => e.status === 422);
  await pp.recordRefund(inv.id, { method: 'BANK_TRANSFER', amount: '50.00', currency: 'EUR' });
  const after = await pp.get(inv.id);
  assert.strictEqual(after.status, 'PARTIALLY_REFUNDED');
  assert.strictEqual(after.refunds.refund_amount.value, '50.00');
});

test('drafts can be deleted, sent invoices cancelled', async () => {
  const pp = mk();
  const d = await pp.createDraft(payload('DEL-1'));
  await pp.remove(d.id);
  await assert.rejects(pp.get(d.id), (e) => e.status === 404 && e.paypal.name === 'RESOURCE_NOT_FOUND');
  const s = await pp.createDraft(payload('CAN-1'));
  await pp.send(s.id);
  await pp.cancel(s.id);
  assert.strictEqual((await pp.get(s.id)).status, 'CANCELLED');
});

test('webhook signature check rejects unsigned events', async () => {
  const pp = mk();
  assert.strictEqual((await pp.verifyWebhook({})).verified, false);
  assert.strictEqual((await pp.verifyWebhook(pp.webhookHeaders())).verified, true);
});
