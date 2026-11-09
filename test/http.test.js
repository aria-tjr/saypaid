'use strict';
// Boots the real server and exercises the HTTP API, including the mock payer page and webhook delivery.
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 39000 + Math.floor(Math.random() * 500);
const base = `http://127.0.0.1:${PORT}`;
let proc;
const http = require('node:http');
const crypto = require('node:crypto');
const received = [];
const sink = http.createServer((req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { received.push({ headers: req.headers, body: b }); res.end('ok'); }); });
const j = async (p, opts = {}) => { const r = await fetch(base + p, { headers: { 'Content-Type': 'application/json' }, ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined }); return { status: r.status, body: r.headers.get('content-type')?.includes('json') ? await r.json() : await r.arrayBuffer() }; };

test.before(async () => {
  await new Promise((r) => sink.listen(0, '127.0.0.1', r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'saypaid-http-'));
  proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(PORT), SAYPAID_DATA_DIR: dir, PAYPAL_MODE: 'mock', LLM_PROVIDER: 'offline', MOCK_LATENCY_MS: '0', AUTOMATION_WEBHOOK_URL: `http://127.0.0.1:${sink.address().port}/hook`, AUTOMATION_SECRET: 'test-secret' }, stdio: 'pipe' });
  for (let i = 0; i < 50; i++) { try { if ((await fetch(base + '/healthz')).ok) return; } catch {} await new Promise((r) => setTimeout(r, 100)); }
  throw new Error('server did not start');
});
test.after(() => { proc?.kill(); sink.close(); });

test('state, security headers and path traversal', async () => {
  const r = await fetch(base + '/api/state');
  assert.strictEqual(r.headers.get('x-content-type-options'), 'nosniff');
  const s = await r.json();
  assert.strictEqual(s.mode.paypal, 'mock');
  assert.ok(s.invoices.length >= 9);
  assert.strictEqual((await fetch(base + '/..%2f..%2fpackage.json')).status, 404);
});

test('voice -> card -> approve -> payer pays on mock page -> webhook marks PAID', async () => {
  const a = await j('/api/agent', { method: 'POST', body: { text: 'Invoice Okafor Studio for 2 hours socket repair at 65 an hour', session: 'h' } });
  assert.strictEqual(a.status, 200);
  const id = a.body.steps[0].result.draft.invoice_id;
  const card = (await j('/api/state')).body.approvals.find((x) => x.status === 'pending' && x.invoice.id === id);
  const bad = await j(`/api/approvals/${card.id}`, { method: 'POST', body: { decision: 'approve', fingerprint: 'nope' } });
  assert.strictEqual(bad.status, 409);
  const ok = await j(`/api/approvals/${card.id}`, { method: 'POST', body: { decision: 'approve', fingerprint: card.fingerprint } });
  assert.strictEqual(ok.body.status, 'executed');
  const pdf = await fetch(`${base}/api/invoices/${id}/pdf`);
  assert.strictEqual(pdf.headers.get('content-type'), 'application/pdf');
  const page = await fetch(`${base}/mock-pay/${id}`);
  assert.match(await page.text(), /SIMULATED CHECKOUT/);
  const pay = await j(`/mock-pay/${id}/pay`, { method: 'POST', body: { method: 'PAYPAL' } });
  assert.strictEqual(pay.body.status, 'PAID');
  await new Promise((r) => setTimeout(r, 1400));
  const audit = (await j('/api/audit')).body;
  assert.ok(audit.entries.some((e) => e.action === 'webhook.received'));
  assert.ok(audit.verify.ok);
});

test('unsigned webhooks are rejected', async () => {
  const r = await j('/api/webhooks/paypal', { method: 'POST', body: { event_type: 'INVOICING.INVOICE.PAID', resource: {} } });
  assert.strictEqual(r.status, 400);
  assert.match(r.body.error, /signature/);
});

test('errors are JSON with a useful message', async () => {
  const r = await j('/api/invoices/INV2-AAAA-BBBB-CCCC-DDDD');
  assert.strictEqual(r.status, 404);
  assert.match(r.body.error, /RESOURCE_NOT_FOUND/);
  const d = await j('/api/approvals/apr_x', { method: 'POST', body: { decision: 'maybe' } });
  assert.strictEqual(d.status, 400);
});

test('automation events are delivered with a valid HMAC signature', async () => {
  for (let i = 0; i < 20 && !received.some((r) => r.headers['x-saypaid-event'] === 'invoice.paid'); i++) await new Promise((r) => setTimeout(r, 100));
  const paid = received.find((r) => r.headers['x-saypaid-event'] === 'invoice.paid');
  assert.ok(paid, 'invoice.paid delivered');
  const expected = 'sha256=' + crypto.createHmac('sha256', 'test-secret').update(paid.body).digest('hex');
  assert.strictEqual(paid.headers['x-saypaid-signature'], expected);
  assert.strictEqual(JSON.parse(paid.body).data.currency, 'EUR');
});
