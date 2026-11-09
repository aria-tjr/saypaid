'use strict';
// Real PayPal REST client (sandbox by default). Zero dependencies: uses global fetch.
// Every call is reported to `onTrace` so the UI can show a live API trace.

class PayPalClient {
  constructor({ clientId, clientSecret, baseUrl, webhookId }, onTrace = () => {}) {
    if (!clientId || !clientSecret) throw new Error('PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET are required in sandbox mode');
    this.mode = 'sandbox';
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.baseUrl = baseUrl;
    this.webhookId = webhookId;
    this.onTrace = onTrace;
    this.token = null;
    this.tokenExp = 0;
  }

  async accessToken() {
    if (this.token && Date.now() < this.tokenExp - 60000) return this.token;
    const t0 = Date.now();
    const res = await fetch(`${this.baseUrl}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });
    this.onTrace({ mode: this.mode, method: 'POST', path: '/v1/oauth2/token', status: res.status, ms: Date.now() - t0 });
    if (!res.ok) throw new Error(`PayPal OAuth failed (${res.status}): ${await res.text()}`);
    const j = await res.json();
    this.token = j.access_token;
    this.tokenExp = Date.now() + j.expires_in * 1000;
    return this.token;
  }

  async request(method, path, body, { requestId, prefer } = {}) {
    const token = await this.accessToken();
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    if (requestId) headers['PayPal-Request-Id'] = requestId; // idempotency for money-moving calls
    if (prefer) headers.Prefer = prefer;
    const t0 = Date.now();
    const res = await fetch(this.baseUrl + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    this.onTrace({ mode: this.mode, method, path, status: res.status, ms: Date.now() - t0, debugId: res.headers.get('paypal-debug-id') });
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
    if (!res.ok) {
      const detail = data?.details?.map((d) => `${d.issue}: ${d.description || ''}`).join('; ');
      const err = new Error(`PayPal ${method} ${path} -> ${res.status} ${data?.name || ''} ${detail || data?.message || ''}`.trim());
      err.status = res.status;
      err.paypal = data;
      throw err;
    }
    return data;
  }

  async nextInvoiceNumber() {
    const r = await this.request('POST', '/v2/invoicing/generate-next-invoice-number');
    return r.invoice_number;
  }

  async createDraft(payload, requestId) {
    const r = await this.request('POST', '/v2/invoicing/invoices', payload, { requestId, prefer: 'return=representation' });
    if (r && r.id) return r;
    const href = r?.href || r?.links?.find((l) => l.rel === 'self')?.href;
    const id = href ? href.split('/').pop() : null;
    if (!id) throw new Error('PayPal did not return an invoice id');
    return this.get(id);
  }

  get(id) {
    return this.request('GET', `/v2/invoicing/invoices/${encodeURIComponent(id)}`);
  }

  async list() {
    const r = await this.request('GET', '/v2/invoicing/invoices?page=1&page_size=100&total_required=true&fields=all');
    return r.items || [];
  }

  // Full update of a draft (PUT replaces the invoice).
  async update(id, payload, requestId) {
    const r = await this.request('PUT', `/v2/invoicing/invoices/${encodeURIComponent(id)}?send_to_recipient=false&send_to_invoicer=false`, payload, { requestId, prefer: 'return=representation' });
    return r && r.id ? r : this.get(id);
  }

  remove(id) {
    return this.request('DELETE', `/v2/invoicing/invoices/${encodeURIComponent(id)}`);
  }

  recordRefund(id, { method, amount, currency, date }, requestId) {
    return this.request('POST', `/v2/invoicing/invoices/${encodeURIComponent(id)}/refunds`,
      { method, refund_date: date, amount: { currency_code: currency, value: amount } }, { requestId });
  }

  send(id, { subject, note } = {}, requestId) {
    return this.request('POST', `/v2/invoicing/invoices/${encodeURIComponent(id)}/send`,
      { subject, note, send_to_invoicer: true, send_to_recipient: true }, { requestId });
  }

  remind(id, { subject, note } = {}, requestId) {
    return this.request('POST', `/v2/invoicing/invoices/${encodeURIComponent(id)}/remind`,
      { subject, note, send_to_invoicer: false, send_to_recipient: true }, { requestId });
  }

  cancel(id, { note } = {}, requestId) {
    return this.request('POST', `/v2/invoicing/invoices/${encodeURIComponent(id)}/cancel`,
      { subject: 'Invoice cancelled', note, send_to_invoicer: true, send_to_recipient: true }, { requestId });
  }

  recordPayment(id, { method, amount, currency, date, note }, requestId) {
    return this.request('POST', `/v2/invoicing/invoices/${encodeURIComponent(id)}/payments`,
      { method, payment_date: date, note, amount: { currency_code: currency, value: amount } }, { requestId });
  }

  async verifyWebhook(headers, event) {
    if (!this.webhookId) return { verified: false, reason: 'PAYPAL_WEBHOOK_ID not set' };
    const r = await this.request('POST', '/v1/notifications/verify-webhook-signature', {
      auth_algo: headers['paypal-auth-algo'],
      cert_url: headers['paypal-cert-url'],
      transmission_id: headers['paypal-transmission-id'],
      transmission_sig: headers['paypal-transmission-sig'],
      transmission_time: headers['paypal-transmission-time'],
      webhook_id: this.webhookId,
      webhook_event: event,
    });
    return { verified: r.verification_status === 'SUCCESS', reason: r.verification_status };
  }
}

module.exports = { PayPalClient };
