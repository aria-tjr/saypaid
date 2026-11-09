'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { freshApp, line } = require('./helpers');
const { invoicePdf } = require('../lib/pdf');

test('end to end: voice -> PayPal draft -> human approval -> sent -> customer pays', async () => {
  const app = freshApp();
  await app.resetDemo();
  const out = await app.agent.handle('t', 'Invoice Cafe Morgenrot for 3.5 hours espresso machine repair at 70 an hour, plus 48 euros for a new pump gasket.');
  const step = out.steps[0];
  assert.strictEqual(step.tool, 'draft_invoice');
  assert.strictEqual(step.result.draft.total, '€348.67');
  const inv = await app.backoffice.invoice(step.result.draft.invoice_id);
  assert.strictEqual(inv.status, 'DRAFT', 'the AI must not send by itself');
  const appr = app.store.getApproval(step.result.approval.approval_id);
  await assert.rejects(app.backoffice.decide(appr.id, 'approve', { fingerprint: 'tampered' }), /fingerprint/);
  const done = await app.backoffice.decide(appr.id, 'approve', { fingerprint: appr.fingerprint });
  assert.strictEqual(done.status, 'executed');
  await assert.rejects(app.backoffice.decide(appr.id, 'approve'), /already executed/);
  assert.strictEqual((await app.backoffice.invoice(inv.id)).status, 'SENT');
  const evt = app.paypal.simulatePayerPayment(inv.id);
  await app.backoffice.handleWebhook(evt, { verified: true });
  await app.backoffice.handleWebhook(evt, { verified: true }); // duplicate delivery is ignored
  const paid = await app.backoffice.invoice(inv.id);
  assert.strictEqual(paid.status, 'PAID');
  assert.strictEqual(app.audit.entries.filter((e) => e.action === 'webhook.received').length, 1);
  assert.ok(app.audit.verify().ok);
});

test('German voice note replies in German', async () => {
  const app = freshApp();
  await app.resetDemo();
  const out = await app.agent.handle('de', 'Rechnung an Kraemer Bakery: 2 Stunden Ofeninspektion, plus 25 Euro für die Anfahrt.');
  assert.strictEqual(out.lang, 'de');
  assert.match(out.reply, /Freigabe|Entwurf/);
});

test('editing a draft updates PayPal and replaces the pending card', async () => {
  const app = freshApp();
  await app.resetDemo();
  const r = await app.backoffice.callTool('draft_invoice', { customer: 'Kraemer Bakery', items: [line('Oven inspection', 2, 65, 'HOURS')] });
  const old = r.approval.approval_id;
  await app.backoffice.editDraft(r.draft.invoice_id, { items: [line('Oven inspection', 2.5, 65, 'HOURS'), line('Call-out', 1, 25)] });
  assert.strictEqual(app.store.getApproval(old).status, 'superseded');
  const inv = await app.backoffice.invoice(r.draft.invoice_id);
  assert.strictEqual(inv.total_cents, Math.round((162.5 + 25) * 119));
  await assert.rejects(app.backoffice.decide(old, 'approve'), /superseded|not pending/);
  const fresh = app.store.recentApprovals(5).find((a) => a.status === 'pending' && a.invoice.id === inv.id);
  assert.ok(fresh);
  assert.strictEqual(fresh.invoice.total_cents, inv.total_cents);
  await assert.rejects(app.backoffice.editDraft(inv.id, { items: [line('', 1, 5)] }), /Invalid line item/);
});

test('discarding a draft deletes it in PayPal', async () => {
  const app = freshApp();
  await app.resetDemo();
  const r = await app.backoffice.callTool('draft_invoice', { customer: 'Okafor Studio', items: [line('Socket', 1, 65, 'HOURS')] });
  await app.backoffice.discardDraft(r.draft.invoice_id);
  assert.ok(!(await app.backoffice.invoices()).some((i) => i.id === r.draft.invoice_id));
});

test('guardrails: hard limit, duplicate, reminder cooldown, overpayment', async () => {
  const app = freshApp();
  await app.resetDemo();
  const big = await app.backoffice.callTool('draft_invoice', { customer: 'Okafor Studio', items: [line('Full rewiring', 100, 65, 'HOURS')] });
  assert.ok(big.approval.blocked, 'above hard limit must be blocked');
  const items = [line('Socket repair', 1, 65, 'HOURS')];
  const a1 = await app.backoffice.callTool('draft_invoice', { customer: 'Kraemer Bakery', items });
  await app.backoffice.decide(a1.approval.approval_id, 'approve');
  const a2 = await app.backoffice.callTool('draft_invoice', { customer: 'Kraemer Bakery', items });
  assert.ok(a2.approval.flags.some((f) => /duplicate/i.test(f)));
  const r1 = await app.backoffice.callTool('propose_reminder', { customer: 'Okafor Studio' });
  await app.backoffice.decide(r1.approval_id, 'approve');
  const r2 = await app.backoffice.callTool('propose_reminder', { customer: 'Okafor Studio' });
  assert.ok(r2.blocked && /cooldown|already/i.test(r2.reasons[0]));
  const p = await app.backoffice.callTool('propose_record_payment', { customer: 'Okafor Studio', method: 'CASH', amount: 99999 });
  assert.ok(p.blocked && /more than/i.test(p.reasons[0]));
});

test('refunds are capped at the paid amount; cancel works on open invoices', async () => {
  const app = freshApp();
  await app.resetDemo();
  const paid = (await app.backoffice.invoices()).find((i) => i.status === 'PAID');
  const tooMuch = await app.backoffice.proposeFor('record_refund', { invoice_id: paid.id, amount: paid.paid_cents / 100 + 1 });
  assert.ok(tooMuch.blocked);
  const ok = await app.backoffice.proposeFor('record_refund', { invoice_id: paid.id, amount: 10 });
  assert.ok(ok.approval_id);
  assert.strictEqual((await app.backoffice.decide(ok.approval_id, 'approve')).status, 'executed');
  assert.strictEqual((await app.backoffice.invoice(paid.id)).refunded_cents, 1000);
  const open = (await app.backoffice.invoices()).find((i) => i.status === 'SENT');
  const c = await app.backoffice.proposeFor('cancel_invoice', { invoice_id: open.id });
  await app.backoffice.decide(c.approval_id, 'approve');
  assert.strictEqual((await app.backoffice.invoice(open.id)).status, 'CANCELLED');
});

test('rejecting a card never calls PayPal', async () => {
  const app = freshApp();
  await app.resetDemo();
  const r = await app.backoffice.callTool('draft_invoice', { customer: 'Okafor Studio', items: [line('Socket', 1, 65, 'HOURS')] });
  await app.backoffice.decide(r.approval.approval_id, 'reject');
  assert.strictEqual((await app.backoffice.invoice(r.draft.invoice_id)).status, 'DRAFT');
});

test('new customer requires an email before anything is drafted', async () => {
  const app = freshApp();
  await app.resetDemo();
  const r = await app.backoffice.callTool('draft_invoice', { customer: 'Nordlicht Hostel', items: [line('Lights', 2, 65, 'HOURS')] });
  assert.strictEqual(r.needs, 'customer_email');
  const ok = await app.backoffice.callTool('draft_invoice', { customer: 'Nordlicht Hostel', customer_email: 'info@nordlicht.example', items: [line('Lights', 2, 65, 'HOURS')] });
  assert.ok(ok.approval.flags.some((f) => /New recipient/.test(f)));
});

test('dashboard analytics and PDF', async () => {
  const app = freshApp();
  await app.resetDemo();
  const all = await app.backoffice.invoices();
  const s = await app.backoffice.summary(all);
  const a = app.backoffice.analytics(all);
  assert.strictEqual(a.weeks.length, 8);
  assert.strictEqual(a.aging.reduce((x, b) => x + b.cents, 0), s.outstanding_cents);
  const pdf = invoicePdf(all[0], app.config.business, { mock: true });
  assert.strictEqual(pdf.subarray(0, 5).toString(), '%PDF-');
  assert.match(pdf.subarray(-6).toString(), /%%EOF/);
});

test('automation events are emitted for executed actions', async () => {
  const app = freshApp();
  await app.resetDemo();
  const r = await app.backoffice.callTool('draft_invoice', { customer: 'Okafor Studio', items: [line('Socket', 1, 65, 'HOURS')] });
  await app.backoffice.decide(r.approval.approval_id, 'approve');
  const types = app.outbox.map((e) => e.type);
  assert.ok(types.includes('invoice.drafted') && types.includes('invoice.sent'), types.join());
});
