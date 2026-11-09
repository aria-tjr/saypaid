'use strict';
// The business core: agent tools, the approval workflow, execution against PayPal,
// webhook handling, analytics and outbound automation events (n8n).
const crypto = require('node:crypto');
const { buildInvoicePayload, normalize, isoDate, addDays, OPEN, PAID } = require('./invoice');
const { invoiceTotals, fmt, toCents, fromCents } = require('./money');
const policy = require('./policy');

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const fingerprint = (o) => crypto.createHash('sha256').update(JSON.stringify(o)).digest('hex').slice(0, 12);
const dateWords = (iso) => (iso ? new Date(iso.slice(0, 10) + 'T12:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '');
const METHOD_WORDS = { CASH: 'cash', BANK_TRANSFER: 'bank transfer', CHECK: 'cheque', OTHER: 'other', PAYPAL: 'PayPal' };
const httpErr = (status, msg) => Object.assign(new Error(msg), { status });

class Backoffice {
  constructor({ config, paypal, store, audit, publish = () => {}, emit = () => {} }) {
    Object.assign(this, { config, paypal, store, audit, publish, emit });
    this.lastStatuses = new Map();
  }
  get cur() { return this.config.business.currency; }

  // ============================================================== reads
  async invoices() {
    const raw = await this.paypal.list();
    return raw.map((r) => ({ ...normalize(r), meta: this.store.meta(r.id) }));
  }
  async invoice(id) {
    const n = normalize(await this.paypal.get(id));
    return { ...n, meta: this.store.meta(id) };
  }
  async summary(all) {
    all = all || (await this.invoices());
    const open = all.filter((i) => OPEN.has(i.status) || i.status === 'PARTIALLY_PAID');
    const overdue = open.filter((i) => i.overdue);
    const paid = all.filter((i) => i.paid_cents > 0);
    return {
      currency: this.cur,
      outstanding_cents: open.reduce((s, i) => s + i.due_cents, 0),
      overdue_cents: overdue.reduce((s, i) => s + i.due_cents, 0),
      paid_cents: paid.reduce((s, i) => s + i.paid_cents - i.refunded_cents, 0),
      counts: { open: open.length, overdue: overdue.length, paid: all.filter((i) => PAID.has(i.status)).length, drafts: all.filter((i) => i.status === 'DRAFT').length, total: all.length },
    };
  }
  // Data for the dashboard charts. Derived only from invoices that exist in PayPal (or the mock).
  analytics(all, today = new Date()) {
    const weeks = [];
    for (let w = 7; w >= 0; w--) {
      const end = addDays(today, -7 * w);
      const start = addDays(end, -6);
      weeks.push({ label: isoDate(start).slice(5), from: isoDate(start), to: isoDate(end), paid_cents: 0, invoiced_cents: 0 });
    }
    for (const i of all) {
      for (const p of i.payments) { const wk = weeks.find((w) => p.date >= w.from && p.date <= w.to); if (wk) wk.paid_cents += p.cents; }
      if (i.status !== 'DRAFT' && i.status !== 'CANCELLED') { const wk = weeks.find((w) => i.invoice_date >= w.from && i.invoice_date <= w.to); if (wk) wk.invoiced_cents += i.total_cents; }
    }
    const aging = [
      { label: 'Not due', cents: 0 }, { label: '1–15 days', cents: 0 }, { label: '16–30 days', cents: 0 }, { label: '30+ days', cents: 0 },
    ];
    for (const i of all.filter((x) => OPEN.has(x.status) || x.status === 'PARTIALLY_PAID')) {
      const b = !i.overdue ? 0 : i.days_overdue <= 15 ? 1 : i.days_overdue <= 30 ? 2 : 3;
      aging[b].cents += i.due_cents;
    }
    return { weeks, aging };
  }
  timeline(id) {
    return this.audit.entries.filter((e) => e.details?.invoice_id === id || e.details?.args?.invoice_id === id || e.details?.invoice?.id === id)
      .map((e) => ({ ts: e.ts, actor: e.actor, action: e.action }));
  }

  async resolveInvoice({ invoice_id, customer }, action) {
    const all = await this.invoices();
    if (invoice_id) {
      const hit = all.find((i) => i.id === invoice_id || i.number === invoice_id);
      if (hit) return hit;
    }
    if (customer) {
      const q = String(customer).toLowerCase().replace(/\b(the|die|der|das|an|für)\b/g, ' ').trim();
      const hits = all.filter((i) => `${i.customer} ${i.contact} ${i.email}`.toLowerCase().includes(q)
        || q.split(/\s+/).some((t) => t.length > 3 && `${i.customer} ${i.contact}`.toLowerCase().includes(t)));
      const unpaid = hits.filter((i) => OPEN.has(i.status) || i.status === 'PARTIALLY_PAID');
      const drafts = hits.filter((i) => i.status === 'DRAFT');
      const paid = hits.filter((i) => i.paid_cents > i.refunded_cents);
      const pick = action === 'cancel_invoice' ? [...unpaid, ...drafts] : action === 'record_refund' ? paid : action === 'revise_draft' ? drafts : unpaid;
      return pick[0] || null;
    }
    return null;
  }

  // ============================================================== agent tools
  toolDefinitions() {
    const item = {
      type: 'object',
      properties: {
        description: { type: 'string', description: 'What was done or supplied, as it should appear on the invoice (keep the language the owner used)' },
        quantity: { type: 'number', description: 'Hours or count' },
        unit_price: { type: 'number', description: `Net price per unit in ${this.cur}, before VAT` },
        unit: { type: 'string', enum: ['HOURS', 'QUANTITY'] },
      },
      required: ['description', 'quantity', 'unit_price', 'unit'],
    };
    return [
      { name: 'find_customer', description: 'Look up a customer in the address book by name, company or email.', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
      { name: 'draft_invoice', description: 'Create a DRAFT invoice in PayPal from a spoken job report and queue it for the owner to approve before it is sent. Never sends anything by itself.', parameters: { type: 'object', properties: { customer: { type: 'string', description: 'Customer name or company as spoken' }, customer_email: { type: 'string', description: 'Only if the owner said an email address (needed for new customers)' }, items: { type: 'array', items: item }, due_in_days: { type: 'number' }, note: { type: 'string', description: 'Optional short note to the customer, only if dictated' } }, required: ['customer', 'items'] } },
      { name: 'revise_draft', description: 'Replace the line items of an existing DRAFT invoice (e.g. "make that 4 hours"). Always pass the complete new list of items.', parameters: { type: 'object', properties: { invoice_id: { type: 'string' }, customer: { type: 'string' }, items: { type: 'array', items: item } }, required: ['items'] } },
      { name: 'list_invoices', description: 'List invoices. Use for questions like "who owes me money".', parameters: { type: 'object', properties: { status: { type: 'string', enum: ['open', 'overdue', 'paid', 'draft', 'all'] } }, required: ['status'] } },
      { name: 'get_summary', description: 'Totals: outstanding, overdue, paid.', parameters: { type: 'object', properties: {} } },
      { name: 'propose_reminder', description: 'Queue a PayPal payment reminder for an unpaid invoice (owner must approve).', parameters: { type: 'object', properties: { invoice_id: { type: 'string', description: 'Exact invoice id from list_invoices, if known' }, customer: { type: 'string' } } } },
      { name: 'propose_record_payment', description: 'Queue marking an invoice as paid by cash, bank transfer or cheque (owner must approve).', parameters: { type: 'object', properties: { invoice_id: { type: 'string' }, customer: { type: 'string' }, method: { type: 'string', enum: ['CASH', 'BANK_TRANSFER', 'CHECK', 'OTHER'] }, amount: { type: 'number', description: 'Amount received; omit for the full amount due' } }, required: ['method'] } },
      { name: 'propose_refund', description: 'Queue recording a refund on a paid invoice (owner must approve).', parameters: { type: 'object', properties: { invoice_id: { type: 'string' }, customer: { type: 'string' }, amount: { type: 'number' }, method: { type: 'string', enum: ['CASH', 'BANK_TRANSFER', 'CHECK', 'OTHER'] } }, required: ['amount'] } },
      { name: 'propose_cancel', description: 'Queue cancelling a sent invoice (owner must approve).', parameters: { type: 'object', properties: { invoice_id: { type: 'string' }, customer: { type: 'string' }, reason: { type: 'string' } } } },
    ];
  }

  async callTool(name, args, ctx = {}) {
    this.audit.append('agent', `tool.${name}`, { args });
    try {
      switch (name) {
        case 'find_customer': return { matches: this.store.findCustomers(args.query).slice(0, 5) };
        case 'draft_invoice': return await this.draftInvoice(args, ctx);
        case 'revise_draft': {
          const inv = await this.resolveInvoice(args, 'revise_draft') || (await this.invoices()).find((i) => i.status === 'DRAFT');
          if (!inv) return { error: 'No draft invoice found to revise.' };
          return await this.editDraft(inv.id, { items: args.items }, 'agent');
        }
        case 'list_invoices': return await this.listForAgent(args.status || 'open');
        case 'get_summary': {
          const s = await this.summary();
          return { outstanding: fmt(s.outstanding_cents, this.cur), overdue: fmt(s.overdue_cents, this.cur), paid: fmt(s.paid_cents, this.cur), counts: s.counts };
        }
        case 'propose_reminder': return await this.proposeFor('send_reminder', args);
        case 'propose_record_payment': return await this.proposeFor('record_payment', args);
        case 'propose_refund': return await this.proposeFor('record_refund', args);
        case 'propose_cancel': return await this.proposeFor('cancel_invoice', args);
        default: return { error: `unknown tool ${name}` };
      }
    } catch (e) {
      this.audit.append('system', 'tool.error', { tool: name, error: e.message });
      return { error: e.paypal?.details?.[0]?.description || e.message };
    }
  }

  async listForAgent(status) {
    const all = await this.invoices();
    const f = {
      open: (i) => OPEN.has(i.status) || i.status === 'PARTIALLY_PAID',
      overdue: (i) => i.overdue,
      paid: (i) => PAID.has(i.status),
      draft: (i) => i.status === 'DRAFT',
      all: () => true,
    }[status] || (() => true);
    const rows = all.filter(f).map((i) => ({ invoice_id: i.id, number: i.number, customer: i.customer, status: i.display_status, amount_due: fmt(i.due_cents, i.currency), total: fmt(i.total_cents, i.currency), due_date: i.due_date, days_overdue: i.days_overdue || undefined }));
    return { status, count: rows.length, total_due: fmt(all.filter(f).reduce((s, i) => s + i.due_cents, 0), this.cur), invoices: rows };
  }

  validateItems(items) {
    if (!Array.isArray(items) || !items.length) throw httpErr(400, 'At least one line item is required.');
    return items.map((it) => {
      const q = Number(String(it.quantity).replace(',', '.'));
      const p = Number(String(it.unit_price).replace(',', '.'));
      if (!String(it.description || '').trim() || !(q > 0) || !(p >= 0) || !isFinite(q) || !isFinite(p)) throw httpErr(400, `Invalid line item: ${JSON.stringify(it)}`);
      return { description: String(it.description).trim().slice(0, 200), quantity: Math.round(q * 100) / 100, unit_price: Math.round(p * 100) / 100, unit: it.unit === 'HOURS' ? 'HOURS' : 'QUANTITY' };
    });
  }

  async draftInvoice(args, ctx) {
    const items = this.validateItems(args.items);
    let customer = this.store.findCustomers(args.customer)[0];
    let newRecipient = false;
    if (!customer) {
      const email = String(args.customer_email || '').trim().toLowerCase();
      if (!EMAIL_RE.test(email)) return { needs: 'customer_email', message: `"${args.customer}" is not in the address book. Ask the owner for the customer's email address.` };
      customer = this.store.addCustomer({ name: args.customer, company: args.customer, email });
      newRecipient = true;
      this.audit.append('agent', 'customer.added', { customer });
    }
    const proposal = { customer, items, due_in_days: args.due_in_days, note: args.note };
    proposal.invoice_number = await this.paypal.nextInvoiceNumber();
    const payload = buildInvoicePayload(proposal, this.config.business);
    const created = await this.paypal.createDraft(payload, `draft-${fingerprint({ payload, t: Date.now() })}`);
    const inv = normalize(created);
    this.store.setMeta(inv.id, { customerId: customer.id, transcript: ctx.transcript || null, lang: ctx.lang || null, createdBy: 'voice-agent', newRecipient });
    this.audit.append('paypal', 'invoice.draft_created', { invoice_id: inv.id, number: inv.number, total: fromCents(inv.total_cents) });
    const ours = invoiceTotals(items, this.config.business.taxRate).total;
    if (ours !== inv.total_cents) this.audit.append('system', 'totals.mismatch', { invoice_id: inv.id, ours, paypal: inv.total_cents });
    this.emit('invoice.drafted', { invoice_id: inv.id, number: inv.number, customer: inv.customer, total: fromCents(inv.total_cents), currency: inv.currency });
    const approval = await this.propose('send_invoice', { invoice_id: inv.id }, { invoice: inv, newRecipient });
    this.publish('invoices', {});
    return {
      draft: { invoice_id: inv.id, number: inv.number, customer: inv.customer, total: fmt(inv.total_cents, inv.currency), due_date: inv.due_date },
      approval: approval.blocked ? { blocked: true, reasons: approval.reasons } : { approval_id: approval.id, status: 'waiting_for_owner_signature', flags: approval.flags.map((f) => f.text) },
    };
  }

  // Edit a draft (UI editor or the agent's revise_draft). Uses PUT, then replaces the pending send card.
  async editDraft(id, { items, due_date, note }, actor = 'human') {
    const inv = await this.invoice(id);
    if (inv.status !== 'DRAFT') throw httpErr(409, `Only drafts can be edited; ${inv.number} is ${inv.status}.`);
    const clean = this.validateItems(items);
    const customer = this.store.getCustomer(inv.meta.customerId) || { name: inv.contact || inv.customer, company: inv.customer, email: inv.email };
    const payload = buildInvoicePayload({ customer, items: clean, invoice_number: inv.number, invoice_date: inv.invoice_date, due_date: due_date || inv.due_date, note: note ?? inv.note }, this.config.business);
    const updated = normalize(await this.paypal.update(id, payload, `edit-${fingerprint({ payload, t: Date.now() })}`));
    this.audit.append(actor, 'invoice.draft_updated', { invoice_id: id, number: updated.number, total: fromCents(updated.total_cents) });
    this.supersede(id);
    const approval = await this.propose('send_invoice', { invoice_id: id }, { invoice: updated, newRecipient: !!inv.meta.newRecipient });
    this.publish('invoices', {});
    return {
      draft: { invoice_id: id, number: updated.number, customer: updated.customer, total: fmt(updated.total_cents, updated.currency) },
      approval: approval.blocked ? { blocked: true, reasons: approval.reasons } : { approval_id: approval.id, status: 'waiting_for_owner_signature', flags: approval.flags.map((f) => f.text) },
    };
  }

  async discardDraft(id) {
    const inv = await this.invoice(id);
    if (inv.status !== 'DRAFT') throw httpErr(409, `Only drafts can be discarded; ${inv.number} is ${inv.status}.`);
    await this.paypal.remove(id);
    this.supersede(id, 'discarded');
    this.audit.append('human', 'invoice.draft_deleted', { invoice_id: id, number: inv.number });
    this.publish('invoices', {});
    return { deleted: true };
  }

  supersede(invoiceId, status = 'superseded') {
    for (const a of this.store.pendingApprovals().filter((x) => x.args.invoice_id === invoiceId)) {
      this.store.updateApproval(a.id, { status, decided_at: new Date().toISOString() });
      this.publish('approval', this.store.getApproval(a.id));
    }
  }

  async proposeFor(action, args) {
    const inv = await this.resolveInvoice(args, action);
    if (!inv) return { error: 'No matching invoice found. Ask the owner which invoice they mean.' };
    const a = { invoice_id: inv.id };
    if (action === 'send_reminder') a.note = `Friendly reminder: invoice ${inv.number} over ${fmt(inv.due_cents, inv.currency)} was due on ${dateWords(inv.due_date)}. You can pay securely online with PayPal or card. Thank you!`;
    if (action === 'record_payment') { a.method = args.method || 'CASH'; a.amount = args.amount ? Number(args.amount).toFixed(2) : fromCents(inv.due_cents); }
    if (action === 'record_refund') { a.method = args.method || 'BANK_TRANSFER'; a.amount = Number(args.amount || fromCents(inv.paid_cents - inv.refunded_cents)).toFixed(2); a.reason = args.reason || 'Refund agreed with customer'; }
    if (action === 'cancel_invoice') a.reason = args.reason || 'Cancelled at the owner\'s request.';
    if (action === 'send_invoice') { /* only invoice_id */ }
    const r = await this.propose(action, a, { invoice: inv, amount: a.amount, meta: this.store.meta(inv.id) });
    return r.blocked ? { blocked: true, reasons: r.reasons } : { approval_id: r.id, status: 'waiting_for_owner_signature', readback: r.readback.text, flags: r.flags.map((f) => f.text) };
  }

  readback(action, a, inv) {
    const money = (c) => fmt(c, inv.currency);
    const items = inv.items.map((i) => `${i.quantity}${i.unit === 'HOURS' ? ' h' : ' ×'} ${i.name} at ${fmt(toCents(i.unit_price), inv.currency)}`).join('; ');
    switch (action) {
      case 'send_invoice':
        return { title: `Send invoice ${inv.number}`, verb: 'Approve & send', text: `Send ${inv.number} to ${inv.customer} <${inv.email}> for ${money(inv.total_cents)} incl. ${this.config.business.taxRate}% VAT, due ${dateWords(inv.due_date)}. Items: ${items}.`, speech: `Ready to send ${inv.customer} an invoice for ${money(inv.total_cents)}, due ${dateWords(inv.due_date)}. Shall I send it?` };
      case 'send_reminder':
        return { title: `Payment reminder · ${inv.number}`, verb: 'Approve & remind', text: `Remind ${inv.customer} <${inv.email}> about ${money(inv.due_cents)} due since ${dateWords(inv.due_date)}.`, message: a.note, speech: `Send ${inv.customer} a reminder about ${money(inv.due_cents)}?` };
      case 'record_payment':
        return { title: `Mark paid · ${inv.number}`, verb: 'Approve & record', text: `Record ${money(toCents(a.amount))} received by ${METHOD_WORDS[a.method]} from ${inv.customer} (open: ${money(inv.due_cents)}).`, speech: `Record ${money(toCents(a.amount))} from ${inv.customer} as paid by ${METHOD_WORDS[a.method]}?` };
      case 'record_refund':
        return { title: `Record refund · ${inv.number}`, verb: 'Approve & record refund', text: `Record a refund of ${money(toCents(a.amount))} to ${inv.customer} by ${METHOD_WORDS[a.method]} (paid so far: ${money(inv.paid_cents - inv.refunded_cents)}). Note: ${a.reason}.`, speech: `Record a refund of ${money(toCents(a.amount))} to ${inv.customer}?` };
      case 'cancel_invoice':
        return { title: `Cancel invoice ${inv.number}`, verb: 'Approve cancellation', text: `Cancel ${inv.number} to ${inv.customer} over ${money(inv.total_cents)} and notify the customer. Reason: ${a.reason}`, speech: `Cancel invoice ${inv.number} for ${inv.customer}?` };
    }
  }

  async propose(action, args, ctx) {
    const existing = this.store.pendingApprovals().find((a) => a.action === action && a.args.invoice_id === args.invoice_id);
    if (existing) return existing;
    const allInvoices = action === 'send_invoice' ? await this.invoices() : [];
    const verdict = policy.evaluate(action, { ...ctx, allInvoices }, this.config);
    if (verdict.blocked) {
      this.audit.append('policy', 'proposal.blocked', { action, args, reasons: verdict.reasons });
      this.publish('blocked', { action, reasons: verdict.reasons });
      return { blocked: true, reasons: verdict.reasons, flags: verdict.flags };
    }
    const inv = ctx.invoice;
    const approval = this.store.addApproval({
      id: 'apr_' + crypto.randomBytes(5).toString('hex'),
      action,
      args,
      fingerprint: fingerprint({ action, args, total: inv.total_cents, items: inv.items }),
      invoice: { id: inv.id, number: inv.number, customer: inv.customer, email: inv.email, total_cents: inv.total_cents, subtotal_cents: inv.subtotal_cents, tax_cents: inv.tax_cents, due_cents: inv.due_cents, currency: inv.currency, items: inv.items, due_date: inv.due_date, status: inv.status },
      readback: this.readback(action, args, inv),
      flags: verdict.flags,
      status: 'pending',
      created_at: new Date().toISOString(),
    });
    this.audit.append('agent', 'proposal.created', { approval_id: approval.id, action, args, fingerprint: approval.fingerprint, flags: verdict.flags.map((f) => f.code) });
    this.publish('approval', approval);
    return approval;
  }

  // ============================================================== human decision
  async decide(approvalId, decision, { fingerprint: fp } = {}) {
    const a = this.store.getApproval(approvalId);
    if (!a) throw httpErr(404, 'approval not found');
    if (a.status !== 'pending') throw httpErr(409, `approval already ${a.status}`);
    if (fp && fp !== a.fingerprint) throw httpErr(409, 'fingerprint mismatch: the action changed after it was shown');
    if (decision === 'reject') {
      this.store.updateApproval(a.id, { status: 'rejected', decided_at: new Date().toISOString() });
      this.audit.append('human', 'proposal.rejected', { approval_id: a.id, action: a.action, invoice_id: a.args.invoice_id });
      this.publish('approval', this.store.getApproval(a.id));
      return this.store.getApproval(a.id);
    }
    this.audit.append('human', 'proposal.approved', { approval_id: a.id, action: a.action, fingerprint: a.fingerprint, invoice_id: a.args.invoice_id });
    let inv;
    try { inv = await this.invoice(a.args.invoice_id); } catch (e) {
      this.store.updateApproval(a.id, { status: 'failed', error: 'Invoice no longer exists in PayPal.', decided_at: new Date().toISOString() });
      this.publish('approval', this.store.getApproval(a.id));
      return this.store.getApproval(a.id);
    }
    // The fingerprint also covers the invoice content: if the draft changed in PayPal since the card was shown, refuse.
    if (a.action === 'send_invoice' && fingerprint({ action: a.action, args: a.args, total: inv.total_cents, items: inv.items }) !== a.fingerprint) {
      this.store.updateApproval(a.id, { status: 'failed', error: 'The draft changed in PayPal after this card was shown. Review the new version.', decided_at: new Date().toISOString() });
      this.audit.append('policy', 'execution.blocked', { approval_id: a.id, reason: 'content drift' });
      this.publish('approval', this.store.getApproval(a.id));
      return this.store.getApproval(a.id);
    }
    const verdict = policy.evaluate(a.action, { invoice: inv, amount: a.args.amount, meta: this.store.meta(inv.id), allInvoices: a.action === 'send_invoice' ? await this.invoices() : [] }, this.config);
    if (verdict.blocked) {
      this.store.updateApproval(a.id, { status: 'failed', error: verdict.reasons.join(' '), decided_at: new Date().toISOString() });
      this.audit.append('policy', 'execution.blocked', { approval_id: a.id, reasons: verdict.reasons });
      this.publish('approval', this.store.getApproval(a.id));
      return this.store.getApproval(a.id);
    }
    try {
      const result = await this.execute(a, inv);
      this.store.updateApproval(a.id, { status: 'executed', result, decided_at: new Date().toISOString() });
      this.audit.append('paypal', `executed.${a.action}`, { approval_id: a.id, invoice_id: a.args.invoice_id, result });
    } catch (e) {
      const msg = e.paypal ? `${e.paypal.name}: ${e.paypal.details?.[0]?.description || e.paypal.message} (debug_id ${e.paypal.debug_id})` : e.message;
      this.store.updateApproval(a.id, { status: 'failed', error: msg, decided_at: new Date().toISOString() });
      this.audit.append('paypal', 'execution.failed', { approval_id: a.id, invoice_id: a.args.invoice_id, error: msg });
    }
    this.publish('approval', this.store.getApproval(a.id));
    this.publish('invoices', {});
    return this.store.getApproval(a.id);
  }

  async execute(a, inv) {
    const id = a.args.invoice_id;
    const rid = a.id; // approval id doubles as PayPal-Request-Id: approving twice can never act twice
    const base = { invoice_id: id, number: inv.number, customer: inv.customer, currency: inv.currency };
    switch (a.action) {
      case 'send_invoice': {
        const r = await this.paypal.send(id, { subject: `Invoice ${inv.number} from ${this.config.business.name}`, note: 'Thank you! You can pay securely with PayPal or card.' }, rid);
        const after = await this.invoice(id);
        this.lastStatuses.set(id, after.status);
        this.emit('invoice.sent', { ...base, total: fromCents(after.total_cents), due_date: after.due_date, payer_url: r?.href || after.payer_url });
        return { payer_url: r?.href || after.payer_url, status: after.status };
      }
      case 'send_reminder': {
        await this.paypal.remind(id, { subject: `Reminder: invoice ${inv.number} from ${this.config.business.name}`, note: a.args.note }, rid);
        const m = this.store.meta(id);
        this.store.setMeta(id, { reminders: [...(m.reminders || []), new Date().toISOString()] });
        this.emit('reminder.sent', { ...base, amount_due: fromCents(inv.due_cents) });
        return { reminded: true };
      }
      case 'record_payment': {
        const r = await this.paypal.recordPayment(id, { method: a.args.method, amount: a.args.amount, currency: this.cur, date: isoDate(new Date()), note: 'Recorded via SayPaid' }, rid);
        this.emit('payment.recorded', { ...base, amount: a.args.amount, method: a.args.method });
        return r;
      }
      case 'record_refund': {
        const r = await this.paypal.recordRefund(id, { method: a.args.method, amount: a.args.amount, currency: this.cur, date: isoDate(new Date()) }, rid);
        this.emit('refund.recorded', { ...base, amount: a.args.amount, method: a.args.method, reason: a.args.reason });
        return r;
      }
      case 'cancel_invoice': {
        await this.paypal.cancel(id, { note: a.args.reason }, rid);
        this.emit('invoice.cancelled', { ...base, reason: a.args.reason });
        return { cancelled: true };
      }
    }
    throw new Error('unknown action');
  }

  // ============================================================== PayPal events
  async handleWebhook(event, { verified, reason } = {}) {
    if (this.store.state.seenEvents?.includes(event.id)) return { duplicate: true };
    this.store.state.seenEvents = [...(this.store.state.seenEvents || []).slice(-200), event.id];
    this.store.save();
    const invRaw = event.resource?.invoice || event.resource;
    this.audit.append('paypal', 'webhook.received', { id: event.id, type: event.event_type, verified, reason, invoice_id: invRaw?.id });
    if (event.event_type === 'INVOICING.INVOICE.PAID' && invRaw) {
      const inv = normalize(invRaw);
      this.lastStatuses.set(inv.id, inv.status);
      const p = { invoice_id: inv.id, number: inv.number, customer: inv.customer, amount: fmt(inv.total_cents, inv.currency), source: 'webhook' };
      this.emit('invoice.paid', { invoice_id: inv.id, number: inv.number, customer: inv.customer, total: fromCents(inv.total_cents), currency: inv.currency });
      this.publish('payment', p);
    }
    this.publish('invoices', {});
    return { ok: true };
  }

  // Polling fallback for sandbox runs where PayPal cannot reach a webhook URL.
  async sync() {
    const all = await this.invoices();
    for (const inv of all) {
      const before = this.lastStatuses.get(inv.id);
      if (before && before !== inv.status && inv.status === 'PAID') {
        this.audit.append('paypal', 'status.changed', { invoice_id: inv.id, from: before, to: inv.status, via: 'poll' });
        this.publish('payment', { invoice_id: inv.id, number: inv.number, customer: inv.customer, amount: fmt(inv.total_cents, inv.currency), source: 'poll' });
      }
      this.lastStatuses.set(inv.id, inv.status);
    }
  }
}

module.exports = { Backoffice, fingerprint };
