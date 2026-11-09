'use strict';
// Sandbox only: creates and SENDS one past-due demo invoice so "who owes me money" has a real answer.
// It runs only when you call it explicitly (npm run seed:sandbox) and logs to the audit trail.
const { createApp } = require('../lib/app');
const { buildInvoicePayload, isoDate, addDays } = require('../lib/invoice');

(async () => {
  const app = createApp();
  if (app.paypal.mode !== 'sandbox') throw new Error('Set PAYPAL_MODE=sandbox first.');
  const c = app.store.getCustomer('c_okafor');
  const now = new Date();
  const payload = buildInvoicePayload({ customer: c, items: [
    { description: 'Studio lighting rewiring', quantity: 4, unit_price: 65, unit: 'HOURS' },
    { description: 'LED driver 60W', quantity: 2, unit_price: 34.9, unit: 'QUANTITY' },
  ], invoice_number: await app.paypal.nextInvoiceNumber() }, app.config.business, addDays(now, -24));
  payload.detail.payment_term = { due_date: isoDate(addDays(now, -10)) };
  const inv = await app.paypal.createDraft(payload);
  await app.paypal.send(inv.id, { subject: 'Invoice (SayPaid demo seed)' });
  app.audit.append('system', 'sandbox.seed', { invoice_id: inv.id });
  console.log('Seeded overdue sandbox invoice', inv.id);
})().catch((e) => { console.error(e.message); process.exit(1); });
