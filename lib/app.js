'use strict';
// Wires config -> PayPal client (sandbox or mock) -> backoffice -> agent, plus outbound automation events.
const crypto = require('node:crypto');
const { build } = require('./config');
const { PayPalClient } = require('./paypal');
const { MockPayPal } = require('./paypal-mock');
const { Store } = require('./store');
const { AuditLog } = require('./audit');
const { Backoffice } = require('./backoffice');
const { Agent } = require('./agent');
const events = require('./events');
const { buildInvoicePayload, isoDate, addDays } = require('./invoice');

function createApp(overrides = {}) {
  const config = { ...build(), ...overrides };
  const trace = [];
  const onTrace = (t) => {
    const entry = { ...t, ts: new Date().toISOString() };
    trace.unshift(entry);
    trace.length = Math.min(trace.length, 150);
    events.publish('trace', entry);
  };
  const paypal = config.paypal.mode === 'sandbox' ? new PayPalClient(config.paypal, onTrace) : new MockPayPal(config.dataDir, onTrace, { latencyMs: overrides.mockLatencyMs ?? Number(process.env.MOCK_LATENCY_MS ?? 140) });
  const store = new Store(config.dataDir);
  const audit = new AuditLog(config.dataDir);

  // Outbound automation hook (e.g. an n8n Webhook node). Signed with HMAC-SHA256 when AUTOMATION_SECRET is set.
  const outbox = [];
  const emit = (type, data) => {
    const evt = { id: 'evt_' + crypto.randomBytes(6).toString('hex'), type, created: new Date().toISOString(), source: 'saypaid', paypal_mode: paypal.mode, data };
    outbox.unshift(evt);
    outbox.length = Math.min(outbox.length, 50);
    events.publish('automation', evt);
    const url = process.env.AUTOMATION_WEBHOOK_URL;
    if (!url) return;
    const body = JSON.stringify(evt);
    const headers = { 'Content-Type': 'application/json', 'X-SayPaid-Event': type };
    if (process.env.AUTOMATION_SECRET) headers['X-SayPaid-Signature'] = 'sha256=' + crypto.createHmac('sha256', process.env.AUTOMATION_SECRET).update(body).digest('hex');
    fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(5000) })
      .then((r) => audit.append('automation', 'event.delivered', { type, status: r.status }))
      .catch((e) => audit.append('automation', 'event.failed', { type, error: e.message }));
  };

  const backoffice = new Backoffice({ config, paypal, store, audit, publish: events.publish, emit });
  const agent = new Agent({ config, backoffice });

  // Fictional demo data for MOCK mode: a few weeks of history so the dashboard has something to show.
  async function resetDemo() {
    if (paypal.mode !== 'mock') throw Object.assign(new Error('reset is only available in mock mode'), { status: 400 });
    const lat = paypal.latencyMs;
    paypal.latencyMs = 0;
    paypal.reset();
    store.reset();
    audit.reset();
    outbox.length = 0;
    audit.append('system', 'demo.reset', { note: 'Fictional demo data seeded (MOCK mode)' });
    const b = config.business;
    const today = new Date();
    const d = (n) => isoDate(addDays(today, -n));
    const mk = async (cust, items, ageDays, termDays, outcome, paidAfter) => {
      const c = store.getCustomer(cust);
      const p = buildInvoicePayload({ customer: c, items, invoice_number: await paypal.nextInvoiceNumber(), invoice_date: d(ageDays), due_in_days: termDays }, b);
      const inv = await paypal.createDraft(p);
      await paypal.send(inv.id);
      paypal.backdate(inv.id, { sentDate: d(ageDays) });
      if (outcome === 'paid') { paypal.simulatePayerPayment(inv.id); paypal.backdate(inv.id, { paidDate: d(ageDays - paidAfter) }); }
      if (outcome === 'cash') { await paypal.recordPayment(inv.id, { method: 'CASH', amount: (await paypal.get(inv.id)).due_amount.value, currency: b.currency, date: d(ageDays - paidAfter) }); }
      store.setMeta(inv.id, { customerId: cust, createdBy: 'demo-seed' });
      return inv.id;
    };
    const H = 'HOURS', Q = 'QUANTITY';
    await mk('c_seeblick', [{ description: 'Emergency call-out, kitchen extractor fan', quantity: 2, unit_price: 85, unit: H }, { description: 'Fan motor capacitor', quantity: 1, unit_price: 42, unit: Q }], 52, 14, 'paid', 9);
    await mk('c_kraemer', [{ description: 'Proofing cabinet thermostat repair', quantity: 1.5, unit_price: 65, unit: H }], 44, 14, 'paid', 6);
    await mk('c_weber', [{ description: 'Treatment room lighting upgrade', quantity: 6, unit_price: 65, unit: H }, { description: 'LED panel 60x60', quantity: 4, unit_price: 39.5, unit: Q }], 37, 14, 'paid', 12);
    await mk('c_okafor', [{ description: 'Studio lighting rewiring', quantity: 4, unit_price: 65, unit: H }, { description: 'LED driver 60W', quantity: 2, unit_price: 34.9, unit: Q }], 40, 14, 'open');
    await mk('c_morgenrot', [{ description: 'Grinder burr replacement', quantity: 1, unit_price: 65, unit: H }, { description: 'Burr set', quantity: 1, unit_price: 58, unit: Q }], 30, 14, 'cash', 4);
    await mk('c_seeblick', [{ description: 'Sauna heater inspection', quantity: 2.5, unit_price: 65, unit: H }], 23, 14, 'paid', 5);
    await mk('c_weber', [{ description: 'Socket circuit fault finding', quantity: 3, unit_price: 65, unit: H }, { description: 'RCD 40A', quantity: 1, unit_price: 64, unit: Q }], 24, 14, 'open');
    await mk('c_kraemer', [{ description: 'Dough mixer motor service', quantity: 2, unit_price: 65, unit: H }, { description: 'Drive belt', quantity: 1, unit_price: 27.5, unit: Q }], 12, 14, 'paid', 3);
    await mk('c_seeblick', [{ description: 'Lobby lighting timer installation', quantity: 1.5, unit_price: 65, unit: H }, { description: 'Astronomical timer switch', quantity: 1, unit_price: 89, unit: Q }], 5, 14, 'open');
    paypal.latencyMs = lat;
    trace.length = 0;
    events.publish('invoices', {});
  }

  return { config, paypal, store, audit, backoffice, agent, trace, outbox, resetDemo, events, emit };
}

module.exports = { createApp };
