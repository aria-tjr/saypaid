'use strict';
// SayPaid HTTP server. Zero dependencies (node:http).
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { createApp } = require('./lib/app');
const { fmt } = require('./lib/money');
const { invoicePdf } = require('./lib/pdf');

const app = createApp();
const { config, backoffice, agent, audit, store, paypal, trace, events, outbox } = app;
const PUBLIC = path.join(__dirname, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
const SECURITY = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'SAMEORIGIN' };

const send = (res, code, body, type = 'application/json') => {
  res.writeHead(code, { 'Content-Type': type, ...SECURITY });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
};
const readBody = (req) => new Promise((resolve, reject) => {
  let d = '';
  req.on('data', (c) => { d += c; if (d.length > 1e6) { reject(Object.assign(new Error('payload too large'), { status: 413 })); req.destroy(); } });
  req.on('end', () => resolve(d));
  req.on('error', reject);
});
const json = async (req) => {
  const raw = await readBody(req);
  try { return raw ? JSON.parse(raw) : {}; } catch { throw Object.assign(new Error('invalid JSON body'), { status: 400 }); }
};
const serveFile = (res, file) => {
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', ...SECURITY });
  fs.createReadStream(file).pipe(res);
};

async function state() {
  const invoices = await backoffice.invoices();
  const summary = await backoffice.summary(invoices);
  return {
    mode: { paypal: paypal.mode, ai: agent.describe() },
    business: config.business,
    policy: config.policy,
    summary: { ...summary, outstanding: fmt(summary.outstanding_cents, summary.currency), overdue: fmt(summary.overdue_cents, summary.currency), paid: fmt(summary.paid_cents, summary.currency) },
    analytics: backoffice.analytics(invoices),
    invoices,
    approvals: store.recentApprovals(40),
    customers: store.customers(),
    automation: { configured: !!process.env.AUTOMATION_WEBHOOK_URL, recent: outbox.slice(0, 8) },
  };
}

// Deliver a mock webhook exactly like PayPal would: an HTTP POST with PayPal-style headers, a moment later.
function deliverMockWebhook(evt) {
  setTimeout(() => {
    fetch(`http://127.0.0.1:${config.port}/api/webhooks/paypal`, { method: 'POST', headers: paypal.webhookHeaders(), body: JSON.stringify(evt) })
      .catch((e) => audit.append('system', 'mock.webhook_failed', { error: e.message }));
  }, 900);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    if (req.method === 'GET' && p === '/healthz') return send(res, 200, { ok: true, paypal: paypal.mode, ai: agent.describe().provider });
    if (req.method === 'GET' && p === '/api/state') return send(res, 200, await state());
    if (req.method === 'GET' && p === '/api/events') return events.subscribe(res);
    if (req.method === 'GET' && p === '/api/trace') return send(res, 200, trace);
    if (req.method === 'GET' && p === '/api/audit') return send(res, 200, { entries: audit.list(300), verify: audit.verify() });
    if (req.method === 'GET' && p === '/api/automation/events') return send(res, 200, outbox);

    if (req.method === 'POST' && p === '/api/agent') {
      const { text, session = 'default' } = await json(req);
      if (!text || !String(text).trim()) return send(res, 400, { error: 'text required' });
      audit.append('human', 'utterance', { text: String(text).slice(0, 1000) });
      const out = await agent.handle(String(session).slice(0, 40), String(text).slice(0, 1000));
      audit.append('agent', 'reply', { text: out.reply, ms: out.ms, engine: out.engine.label });
      return send(res, 200, out);
    }

    let m = p.match(/^\/api\/approvals\/([\w-]+)$/);
    if (req.method === 'POST' && m) {
      const { decision, fingerprint } = await json(req);
      if (!['approve', 'reject'].includes(decision)) return send(res, 400, { error: 'decision must be approve|reject' });
      return send(res, 200, await backoffice.decide(m[1], decision, { fingerprint }));
    }

    m = p.match(/^\/api\/invoices\/(INV2-[\w-]+)(\/pdf|\/edit|\/propose)?$/);
    if (m) {
      const id = m[1];
      if (req.method === 'GET' && !m[2]) {
        const inv = await backoffice.invoice(id);
        return send(res, 200, { invoice: inv, timeline: backoffice.timeline(id) });
      }
      if (req.method === 'GET' && m[2] === '/pdf') {
        const inv = await backoffice.invoice(id);
        const pdf = invoicePdf(inv, config.business, { mock: paypal.mode === 'mock', payerUrl: inv.payer_url?.startsWith('/') ? `http://localhost:${config.port}${inv.payer_url}` : inv.payer_url });
        res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${inv.number}.pdf"`, ...SECURITY });
        return res.end(pdf);
      }
      if (req.method === 'POST' && m[2] === '/edit') {
        const body = await json(req);
        return send(res, 200, await backoffice.editDraft(id, body, 'human'));
      }
      if (req.method === 'POST' && m[2] === '/propose') {
        const { action, amount, method, reason } = await json(req);
        const map = { send: 'send_invoice', remind: 'send_reminder', mark_paid: 'record_payment', refund: 'record_refund', cancel: 'cancel_invoice' };
        if (!map[action]) return send(res, 400, { error: `action must be one of ${Object.keys(map).join(', ')}` });
        audit.append('human', 'ui.request', { action, invoice_id: id });
        if (map[action] === 'send_invoice') {
          const inv = await backoffice.invoice(id);
          const r = await backoffice.propose('send_invoice', { invoice_id: id }, { invoice: inv, newRecipient: !!inv.meta.newRecipient });
          return send(res, 200, r.blocked ? { blocked: true, reasons: r.reasons } : { approval_id: r.id });
        }
        return send(res, 200, await backoffice.proposeFor(map[action], { invoice_id: id, amount, method, reason }));
      }
      if (req.method === 'DELETE' && !m[2]) return send(res, 200, await backoffice.discardDraft(id));
    }

    if (req.method === 'POST' && p === '/api/webhooks/paypal') {
      const raw = await readBody(req);
      let event;
      try { event = JSON.parse(raw || '{}'); } catch { return send(res, 400, { error: 'invalid JSON' }); }
      const v = await paypal.verifyWebhook(req.headers, event).catch((e) => ({ verified: false, reason: e.message }));
      if ((paypal.mode === 'sandbox' && config.paypal.webhookId && !v.verified) || (paypal.mode === 'mock' && !v.verified)) {
        audit.append('paypal', 'webhook.rejected', { reason: v.reason });
        return send(res, 400, { error: 'signature verification failed' });
      }
      return send(res, 200, await backoffice.handleWebhook(event, v));
    }
    if (req.method === 'POST' && p === '/api/automation/overdue-sweep') {
      // Called on a schedule by the n8n workflow in /n8n. Only PROPOSES reminders; the owner still approves.
      if (process.env.AUTOMATION_TOKEN && req.headers['x-automation-token'] !== process.env.AUTOMATION_TOKEN) return send(res, 401, { error: 'bad token' });
      const overdue = (await backoffice.invoices()).filter((i) => i.overdue);
      const out = [];
      for (const inv of overdue) out.push({ number: inv.number, customer: inv.customer, result: await backoffice.callTool('propose_reminder', { invoice_id: inv.id }) });
      audit.append('automation', 'overdue_sweep', { count: overdue.length });
      return send(res, 200, { overdue: overdue.length, proposals: out });
    }
    if (req.method === 'POST' && p === '/api/demo/reset') { await app.resetDemo(); return send(res, 200, { ok: true }); }
    if (req.method === 'POST' && p === '/api/sync') { await backoffice.sync(); return send(res, 200, { ok: true }); }

    // ---- MOCK payer page (stand-in for PayPal's hosted invoice page) ----
    m = p.match(/^\/(?:mock-pay|api\/pay)\/(INV2-[\w-]+)(\/pay)?$/);
    if (m && paypal.mode === 'mock') {
      if (p.startsWith('/mock-pay') && req.method === 'GET') return serveFile(res, path.join(PUBLIC, 'pay.html'));
      if (req.method === 'GET') {
        const inv = await backoffice.invoice(m[1]);
        const { meta, ...pub } = inv;
        return send(res, 200, { invoice: pub, business: config.business.name, taxRate: config.business.taxRate });
      }
      if (req.method === 'POST' && m[2]) {
        const { method } = await json(req);
        const evt = paypal.simulatePayerPayment(m[1], { method: method === 'CARD' ? 'CREDIT_CARD' : 'PAYPAL' });
        deliverMockWebhook(evt);
        const inv = await backoffice.invoice(m[1]);
        return send(res, 200, { ok: true, transaction_id: inv.payments.at(-1)?.id, status: inv.status });
      }
    }

    // ---- static ----
    const rel = p === '/' ? 'index.html' : decodeURIComponent(p).replace(/^\/+/, '');
    const file = path.resolve(PUBLIC, rel);
    if (file.startsWith(PUBLIC + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) return serveFile(res, file);
    send(res, 404, { error: 'not found' });
  } catch (e) {
    if (!e.status || e.status >= 500) console.error(e);
    send(res, e.status && e.status < 600 ? e.status : 500, { error: e.paypal ? `${e.paypal.name}: ${e.paypal.details?.[0]?.description || e.paypal.message}` : e.message, paypal: e.paypal || undefined });
  }
});

server.listen(config.port, async () => {
  if (paypal.mode === 'mock' && !store.state.seeded) {
    await app.resetDemo();
    store.state.seeded = true;
    store.save();
  }
  if (paypal.mode === 'sandbox') setInterval(() => backoffice.sync().catch((e) => console.error('sync', e.message)), 20000);
  console.log(`SayPaid running on http://localhost:${config.port}`);
  console.log(`  PayPal: ${paypal.mode.toUpperCase()}   AI: ${agent.describe().label}`);
});
