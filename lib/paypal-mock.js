'use strict';
// MOCK PayPal Invoicing v2 simulator.
// Mirrors the shapes of the real REST API as documented at developer.paypal.com/docs/api/invoicing/v2/:
//  - INV2-XXXX-XXXX-XXXX-XXXX ids, statuses DRAFT/SENT/PAID/MARKED_AS_PAID/PARTIALLY_PAID/CANCELLED/REFUNDED/...
//  - HATEOAS `links`, `amount.breakdown`, `due_amount`, `payments`, `refunds`, `detail.metadata`
//  - create returns a `self` link unless `Prefer: return=representation`
//  - error bodies { name, message, debug_id, details[{field, location, issue, description}], links }
//  - PayPal-Request-Id idempotency, realistic latency
// It is clearly labelled MOCK everywhere in the UI. Nothing here talks to PayPal.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { invoiceTotals, fromCents, toCents } = require('./money');

const API = 'https://api-m.sandbox.paypal.com';
const hex = (n) => crypto.randomBytes(n).toString('hex').toUpperCase();
const invId = () => 'INV2-' + hex(8).match(/.{4}/g).join('-');
const debugId = () => crypto.randomBytes(7).toString('hex');
const txnId = () => (hex(9)).slice(0, 17);
const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

class PayPalError extends Error {
  constructor(status, name, message, details = []) {
    super(`PayPal(MOCK) ${status} ${name}: ${message}${details.length ? ' (' + details.map((d) => `${d.issue}${d.field ? ' @ ' + d.field : ''}`).join(', ') + ')' : ''}`);
    this.status = status;
    this.paypal = { name, message, debug_id: debugId(), details, links: [{ href: `https://developer.paypal.com/docs/api/invoicing/v2/#error-${details[0]?.issue || name}`, rel: 'information_link', method: 'GET' }] };
  }
}

class MockPayPal {
  constructor(dataDir, onTrace = () => {}, { latencyMs = Number(process.env.MOCK_LATENCY_MS ?? 140), publicBaseUrl = '' } = {}) {
    this.mode = 'mock';
    this.file = path.join(dataDir, 'mock-paypal.json');
    this.onTrace = onTrace;
    this.latencyMs = latencyMs;
    this.publicBaseUrl = publicBaseUrl;
    this.db = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : MockPayPal.empty();
  }
  static empty() { return { seq: 1000, invoices: {}, idem: {} }; }
  persist() { fs.writeFileSync(this.file, JSON.stringify(this.db, null, 2)); }
  reset() { this.db = MockPayPal.empty(); this.persist(); }

  async call(method, p, status, fn, requestId) {
    const t0 = Date.now();
    if (this.latencyMs) await new Promise((r) => setTimeout(r, this.latencyMs * (0.6 + Math.random() * 0.8)));
    const key = requestId ? `${method} ${p} ${requestId}` : null;
    try {
      let r;
      if (key && this.db.idem[key]) r = this.db.idem[key];
      else { r = fn(); if (key) { this.db.idem[key] = r ?? null; this.persist(); } }
      this.onTrace({ mode: 'mock', method, path: p, status, ms: Date.now() - t0, debugId: debugId(), requestId });
      return r == null ? r : structuredClone(r);
    } catch (e) {
      this.onTrace({ mode: 'mock', method, path: p, status: e.status || 500, ms: Date.now() - t0, debugId: e.paypal?.debug_id, error: e.paypal?.details?.[0]?.issue || e.paypal?.name });
      throw e;
    }
  }
  must(id) {
    const inv = this.db.invoices[id];
    if (!inv) throw new PayPalError(404, 'RESOURCE_NOT_FOUND', 'The specified resource does not exist.', [{ issue: 'INVALID_RESOURCE_ID', description: 'Requested resource ID was not found.' }]);
    return inv;
  }
  links(inv) {
    const self = `${API}/v2/invoicing/invoices/${inv.id}`;
    const l = [{ href: self, rel: 'self', method: 'GET' }];
    if (inv.status === 'DRAFT') l.push({ href: `${self}/send`, rel: 'send', method: 'POST' }, { href: self, rel: 'replace', method: 'PUT' }, { href: self, rel: 'delete', method: 'DELETE' });
    if (['SENT', 'UNPAID', 'PARTIALLY_PAID'].includes(inv.status)) l.push({ href: `${self}/remind`, rel: 'remind', method: 'POST' }, { href: `${self}/cancel`, rel: 'cancel', method: 'POST' }, { href: `${self}/payments`, rel: 'record-payment', method: 'POST' });
    if (['PAID', 'MARKED_AS_PAID', 'PARTIALLY_PAID', 'PARTIALLY_REFUNDED'].includes(inv.status)) l.push({ href: `${self}/refunds`, rel: 'record-refund', method: 'POST' });
    l.push({ href: `${self}/generate-qr-code`, rel: 'qr-code', method: 'POST' });
    return l;
  }

  validate(payload, { excludeId } = {}) {
    const d = [];
    if (!payload?.detail?.currency_code) d.push({ field: '/detail/currency_code', location: 'body', issue: 'MISSING_REQUIRED_PARAMETER', description: 'A required field is missing.' });
    const email = payload?.primary_recipients?.[0]?.billing_info?.email_address;
    if (email !== undefined && !EMAIL_RE.test(email)) d.push({ field: '/primary_recipients/0/billing_info/email_address', location: 'body', issue: 'INVALID_PARAMETER_SYNTAX', description: 'The value of a field does not conform to the expected format.' });
    (payload?.items || []).forEach((it, i) => {
      if (!it.name) d.push({ field: `/items/${i}/name`, location: 'body', issue: 'MISSING_REQUIRED_PARAMETER', description: 'A required field is missing.' });
      if (!(Number(it.quantity) > 0)) d.push({ field: `/items/${i}/quantity`, location: 'body', issue: 'INVALID_PARAMETER_VALUE', description: 'Quantity must be greater than zero.' });
      if (!it.unit_amount || !/^\d+(\.\d{1,2})?$/.test(String(it.unit_amount.value))) d.push({ field: `/items/${i}/unit_amount/value`, location: 'body', issue: 'INVALID_PARAMETER_SYNTAX', description: 'The value of a field does not conform to the expected format.' });
    });
    const num = payload?.detail?.invoice_number;
    if (num && Object.values(this.db.invoices).some((x) => x.detail.invoice_number === num && x.id !== excludeId)) d.push({ field: '/detail/invoice_number', location: 'body', issue: 'DUPLICATE_INVOICE_NUMBER', description: 'Invoice number is already used by another invoice.' });
    if (d.length) throw new PayPalError(d[0].issue === 'DUPLICATE_INVOICE_NUMBER' ? 422 : 400, d[0].issue === 'DUPLICATE_INVOICE_NUMBER' ? 'UNPROCESSABLE_ENTITY' : 'INVALID_REQUEST', d[0].issue === 'DUPLICATE_INVOICE_NUMBER' ? 'The requested action could not be performed, semantically incorrect, or failed business validation.' : 'Request is not well-formed, syntactically incorrect, or violates schema.', d);
  }

  materialize(payload, base = {}) {
    const cur = payload.detail.currency_code;
    const items = (payload.items || []).map((it, i) => {
      const line = Math.round(Number(it.quantity) * toCents(it.unit_amount.value));
      const pct = Number(it.tax?.percent || 0);
      return {
        id: base.items?.[i]?.id || 'ITEM-' + hex(8),
        ...it,
        ...(it.tax ? { tax: { name: it.tax.name, percent: String(it.tax.percent), amount: { currency_code: cur, value: fromCents(Math.round((line * pct) / 100)) } } } : {}),
      };
    });
    const rate = Number(payload.items?.[0]?.tax?.percent || 0);
    const t = invoiceTotals(items.map((i) => ({ quantity: i.quantity, unit_price: i.unit_amount.value })), rate);
    const paid = base.payments ? toCents(base.payments.paid_amount?.value || 0) : 0;
    return {
      detail: {
        ...payload.detail,
        invoice_number: payload.detail.invoice_number || base.detail?.invoice_number || String(++this.db.seq),
        payment_term: { term_type: 'DUE_ON_DATE_SPECIFIED', ...(payload.detail.payment_term || {}) },
        metadata: { ...(base.detail?.metadata || {}), last_update_time: nowIso(), created_by_flow: 'REGULAR_SINGLE' },
      },
      invoicer: payload.invoicer,
      primary_recipients: payload.primary_recipients,
      items,
      configuration: { ...(payload.configuration || {}), template_id: 'TEMP-' + hex(8) },
      amount: {
        currency_code: cur,
        value: fromCents(t.total),
        breakdown: {
          item_total: { currency_code: cur, value: fromCents(t.subtotal) },
          discount: { invoice_discount: { amount: { currency_code: cur, value: '0.00' } } },
          tax_total: { currency_code: cur, value: fromCents(t.tax) },
        },
      },
      due_amount: { currency_code: cur, value: fromCents(t.total - paid) },
    };
  }

  // ------------------------------------------------------------------ API surface (same as PayPalClient)
  nextInvoiceNumber() {
    return this.call('POST', '/v2/invoicing/generate-next-invoice-number', 200, () => {
      this.db.seq += 1; this.persist();
      return { invoice_number: `SP-${this.db.seq}` };
    }).then((r) => r.invoice_number);
  }

  async createDraft(payload, requestId, { prefer = 'return=representation' } = {}) {
    const r = await this.call('POST', '/v2/invoicing/invoices', 201, () => {
      this.validate(payload);
      const id = invId();
      const t = nowIso();
      const inv = { id, status: 'DRAFT', ...this.materialize(payload) };
      inv.detail.metadata = { ...inv.detail.metadata, create_time: t, recipient_view_url: `${this.publicBaseUrl}/mock-pay/${id}`, invoicer_view_url: `${this.publicBaseUrl}/mock-pay/${id}?view=invoicer` };
      inv.links = this.links(inv);
      this.db.invoices[id] = inv;
      this.persist();
      return prefer === 'return=representation' ? inv : { rel: 'self', href: `${API}/v2/invoicing/invoices/${id}`, method: 'GET' };
    }, requestId);
    return r.id ? r : this.get(r.href.split('/').pop());
  }

  get(id) { return this.call('GET', `/v2/invoicing/invoices/${id}`, 200, () => this.must(id)); }

  async list() {
    const r = await this.call('GET', '/v2/invoicing/invoices?page=1&page_size=100&total_required=true', 200, () => {
      const items = Object.values(this.db.invoices).sort((a, b) => (b.detail.metadata.create_time || '').localeCompare(a.detail.metadata.create_time || ''));
      return { total_items: items.length, total_pages: 1, items, links: [{ href: `${API}/v2/invoicing/invoices?page=1&page_size=100&total_required=true`, rel: 'self', method: 'GET' }] };
    });
    return r.items;
  }

  update(id, payload, requestId) {
    return this.call('PUT', `/v2/invoicing/invoices/${id}`, 200, () => {
      const inv = this.must(id);
      if (inv.status !== 'DRAFT') throw new PayPalError(422, 'UNPROCESSABLE_ENTITY', 'The requested action could not be performed, semantically incorrect, or failed business validation.', [{ issue: 'INVALID_INVOICE_STATUS', description: `Invoice in status ${inv.status} cannot be updated by SayPaid.` }]);
      this.validate(payload, { excludeId: id });
      const next = { id, status: inv.status, ...this.materialize(payload, inv) };
      next.detail.metadata = { ...inv.detail.metadata, last_update_time: nowIso() };
      next.links = this.links(next);
      this.db.invoices[id] = next;
      this.persist();
      return next;
    }, requestId);
  }

  remove(id) {
    return this.call('DELETE', `/v2/invoicing/invoices/${id}`, 204, () => {
      const inv = this.must(id);
      if (!['DRAFT', 'SCHEDULED'].includes(inv.status)) throw new PayPalError(422, 'UNPROCESSABLE_ENTITY', 'The requested action could not be performed, semantically incorrect, or failed business validation.', [{ issue: 'CANT_DELETE_INVOICE', description: 'Only draft or scheduled invoices can be deleted.' }]);
      delete this.db.invoices[id];
      this.persist();
      return null;
    });
  }

  send(id, _opts, requestId) {
    return this.call('POST', `/v2/invoicing/invoices/${id}/send`, 200, () => {
      const inv = this.must(id);
      if (inv.status !== 'DRAFT') throw new PayPalError(422, 'UNPROCESSABLE_ENTITY', 'The requested action could not be performed, semantically incorrect, or failed business validation.', [{ issue: 'INVOICE_ALREADY_SENT', description: `Invoice is in ${inv.status} status.` }]);
      inv.status = 'SENT';
      const t = nowIso();
      Object.assign(inv.detail.metadata, { first_sent_time: inv.detail.metadata.first_sent_time || t, last_sent_time: t, last_update_time: t });
      inv.links = this.links(inv);
      this.persist();
      return { rel: 'payer-view', href: inv.detail.metadata.recipient_view_url, method: 'GET' };
    }, requestId);
  }

  remind(id, _opts, requestId) {
    return this.call('POST', `/v2/invoicing/invoices/${id}/remind`, 204, () => {
      const inv = this.must(id);
      if (!['SENT', 'UNPAID', 'PARTIALLY_PAID'].includes(inv.status)) throw new PayPalError(422, 'UNPROCESSABLE_ENTITY', 'The requested action could not be performed, semantically incorrect, or failed business validation.', [{ issue: 'INVALID_INVOICE_STATUS', description: `Cannot remind an invoice in ${inv.status} status.` }]);
      inv.detail.metadata.last_reminder_time = nowIso();
      this.persist();
      return null;
    }, requestId);
  }

  cancel(id, _opts, requestId) {
    return this.call('POST', `/v2/invoicing/invoices/${id}/cancel`, 204, () => {
      const inv = this.must(id);
      if (!['SENT', 'UNPAID', 'SCHEDULED'].includes(inv.status)) throw new PayPalError(422, 'UNPROCESSABLE_ENTITY', 'The requested action could not be performed, semantically incorrect, or failed business validation.', [{ issue: 'INVALID_INVOICE_STATUS', description: `Cannot cancel an invoice in ${inv.status} status.` }]);
      inv.status = 'CANCELLED';
      inv.detail.metadata.cancel_time = nowIso();
      inv.links = this.links(inv);
      this.persist();
      return null;
    }, requestId);
  }

  recordPayment(id, { method, amount, currency, date, note }, requestId) {
    return this.call('POST', `/v2/invoicing/invoices/${id}/payments`, 200, () => {
      const inv = this.must(id);
      if (!['SENT', 'UNPAID', 'PARTIALLY_PAID'].includes(inv.status)) throw new PayPalError(422, 'UNPROCESSABLE_ENTITY', 'The requested action could not be performed, semantically incorrect, or failed business validation.', [{ issue: 'INVALID_INVOICE_STATUS', description: `Cannot record a payment for an invoice in ${inv.status} status.` }]);
      const due = toCents(inv.due_amount.value);
      const amt = toCents(amount);
      if (amt <= 0 || amt > due) throw new PayPalError(422, 'UNPROCESSABLE_ENTITY', 'The requested action could not be performed, semantically incorrect, or failed business validation.', [{ field: '/amount/value', issue: 'PAYMENT_AMOUNT_EXCEEDS_DUE', description: 'Payment amount exceeds the amount due.' }]);
      this.addPayment(inv, { payment_id: 'EXTR-' + txnId(), type: 'EXTERNAL', method, payment_date: date, note, amount: { currency_code: currency, value: fromCents(amt) } });
      inv.status = toCents(inv.due_amount.value) === 0 ? 'MARKED_AS_PAID' : 'PARTIALLY_PAID';
      inv.links = this.links(inv);
      this.persist();
      return { payment_id: inv.payments.transactions.at(-1).payment_id };
    }, requestId);
  }

  recordRefund(id, { method, amount, currency, date }, requestId) {
    return this.call('POST', `/v2/invoicing/invoices/${id}/refunds`, 200, () => {
      const inv = this.must(id);
      const paid = toCents(inv.payments?.paid_amount?.value || 0);
      const refunded = toCents(inv.refunds?.refund_amount?.value || 0);
      const amt = toCents(amount);
      if (!paid) throw new PayPalError(422, 'UNPROCESSABLE_ENTITY', 'The requested action could not be performed, semantically incorrect, or failed business validation.', [{ issue: 'INVALID_INVOICE_STATUS', description: 'Invoice has no payments to refund.' }]);
      if (amt <= 0 || amt > paid - refunded) throw new PayPalError(422, 'UNPROCESSABLE_ENTITY', 'The requested action could not be performed, semantically incorrect, or failed business validation.', [{ field: '/amount/value', issue: 'REFUND_AMOUNT_EXCEEDED', description: 'Refund amount exceeds the paid amount.' }]);
      inv.refunds = inv.refunds || { refund_amount: { currency_code: currency, value: '0.00' }, transactions: [] };
      const refund_id = 'EXTR-' + txnId();
      inv.refunds.transactions.push({ refund_id, type: 'EXTERNAL', method, refund_date: date, amount: { currency_code: currency, value: fromCents(amt) } });
      inv.refunds.refund_amount.value = fromCents(refunded + amt);
      const full = refunded + amt === paid;
      inv.status = !full ? 'PARTIALLY_REFUNDED' : inv.status === 'MARKED_AS_PAID' ? 'MARKED_AS_REFUNDED' : 'REFUNDED';
      inv.links = this.links(inv);
      this.persist();
      return { refund_id };
    }, requestId);
  }

  async verifyWebhook(headers) {
    const ok = String(headers['paypal-transmission-sig'] || '').startsWith('MOCK-');
    return { verified: ok, reason: ok ? 'MOCK signature (not cryptographically verified)' : 'missing mock signature' };
  }

  addPayment(inv, txn) {
    const cur = inv.amount.currency_code;
    inv.payments = inv.payments || { paid_amount: { currency_code: cur, value: '0.00' }, transactions: [] };
    inv.payments.transactions.push(txn);
    const paid = toCents(inv.payments.paid_amount.value) + toCents(txn.amount.value);
    inv.payments.paid_amount.value = fromCents(paid);
    inv.due_amount.value = fromCents(Math.max(0, toCents(inv.amount.value) - paid));
    inv.detail.metadata.last_update_time = nowIso();
  }

  // ------------------------------------------------------------------ mock-only helpers
  // The customer pays on the simulated payer page. Returns the webhook event PayPal would POST.
  simulatePayerPayment(id, { method = 'PAYPAL' } = {}) {
    const inv = this.must(id);
    if (!['SENT', 'UNPAID', 'PARTIALLY_PAID'].includes(inv.status)) throw new PayPalError(422, 'UNPROCESSABLE_ENTITY', 'Invoice is not payable.', [{ issue: 'INVALID_INVOICE_STATUS', description: `Invoice is ${inv.status}.` }]);
    const t = nowIso();
    this.addPayment(inv, { payment_id: txnId(), transaction_type: 'CAPTURE', type: 'PAYPAL', method, payment_date: t.slice(0, 10), amount: { ...inv.due_amount } });
    inv.status = 'PAID';
    inv.links = this.links(inv);
    this.persist();
    return this.event('INVOICING.INVOICE.PAID', inv, 'An invoice was paid');
  }
  event(type, inv, summary) {
    return {
      id: 'WH-' + hex(9).slice(0, 17) + '-' + hex(9).slice(0, 17),
      event_version: '1.0',
      create_time: nowIso(),
      resource_type: 'invoices',
      event_type: type,
      summary: `${summary} (MOCK)`,
      resource: { invoice: structuredClone(inv) },
      links: [{ href: `${API}/v1/notifications/webhooks-events/WH-MOCK`, rel: 'self', method: 'GET' }],
    };
  }
  webhookHeaders() {
    return {
      'content-type': 'application/json',
      'paypal-transmission-id': crypto.randomUUID(),
      'paypal-transmission-time': nowIso(),
      'paypal-transmission-sig': 'MOCK-' + crypto.randomBytes(24).toString('base64'),
      'paypal-auth-algo': 'SHA256withRSA',
      'paypal-cert-url': `${API}/v1/notifications/certs/CERT-MOCK`,
      'user-agent': 'PayPal/AUHD-214.0-MOCK',
    };
  }
  // Demo seeding only: backdate dates and payments.
  backdate(id, { invoiceDate, dueDate, sentDate, paidDate }) {
    const inv = this.must(id);
    if (invoiceDate) inv.detail.invoice_date = invoiceDate;
    if (dueDate) inv.detail.payment_term.due_date = dueDate;
    if (sentDate) Object.assign(inv.detail.metadata, { create_time: sentDate + 'T09:00:00Z', first_sent_time: sentDate + 'T09:05:00Z', last_sent_time: sentDate + 'T09:05:00Z' });
    if (paidDate && inv.payments) inv.payments.transactions.forEach((t) => (t.payment_date = paidDate));
    this.persist();
  }
}

module.exports = { MockPayPal, PayPalError };
