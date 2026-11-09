'use strict';
// Local state: address book, pending approvals and per-invoice metadata.
// The invoices themselves live in PayPal (or the mock) and are always read back from there.
const fs = require('node:fs');
const path = require('node:path');

const DEMO_CUSTOMERS = [
  { id: 'c_morgenrot', name: 'Lena Fischer', company: 'Cafe Morgenrot', email: 'lena.fischer@example.com' },
  { id: 'c_kraemer', name: 'Jonas Kraemer', company: 'Kraemer Bakery', email: 'jonas@kraemer-bakery.example' },
  { id: 'c_okafor', name: 'Ada Okafor', company: 'Okafor Studio', email: 'ada@okafor-studio.example' },
  { id: 'c_weber', name: 'Miriam Weber', company: 'Praxis Dr. Weber', email: 'praxis@weber-physio.example' },
  { id: 'c_seeblick', name: 'Tobias Brandt', company: 'Hotel Seeblick', email: 'technik@hotel-seeblick.example' },
];

class Store {
  constructor(dir) {
    this.file = path.join(dir, 'state.json');
    fs.mkdirSync(dir, { recursive: true });
    this.state = fs.existsSync(this.file)
      ? JSON.parse(fs.readFileSync(this.file, 'utf8'))
      : Store.fresh();
  }
  static fresh() {
    // In sandbox mode, point the demo customer at your PayPal *sandbox personal* account so you can pay as the customer.
    const payer = process.env.DEMO_PAYER_EMAIL;
    const customers = DEMO_CUSTOMERS.map((c) => ({ ...c, ...(payer && c.id === 'c_morgenrot' ? { email: payer } : {}) }));
    return { customers, approvals: [], invoiceMeta: {} };
  }
  save() {
    fs.writeFileSync(this.file, JSON.stringify(this.state, null, 2));
  }
  reset() {
    this.state = Store.fresh();
    this.save();
  }

  // ---- customers ----
  customers() {
    return this.state.customers;
  }
  findCustomers(query) {
    const q = String(query || '').toLowerCase().trim();
    if (!q) return [];
    const tokens = q.split(/[^a-z0-9äöüß@.]+/i).filter((t) => t.length > 2);
    return this.state.customers
      .map((c) => {
        const hay = `${c.name} ${c.company} ${c.email}`.toLowerCase();
        const score = hay.includes(q) ? 10 : tokens.filter((t) => hay.includes(t)).length;
        return { c, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((x) => x.c);
  }
  getCustomer(id) {
    return this.state.customers.find((c) => c.id === id);
  }
  addCustomer({ name, company, email }) {
    const id = 'c_' + Math.random().toString(36).slice(2, 8);
    const c = { id, name: name || company, company: company || name, email };
    this.state.customers.push(c);
    this.save();
    return c;
  }

  // ---- approvals ----
  addApproval(a) {
    this.state.approvals.unshift(a);
    this.save();
    return a;
  }
  getApproval(id) {
    return this.state.approvals.find((a) => a.id === id);
  }
  updateApproval(id, patch) {
    const a = this.getApproval(id);
    Object.assign(a, patch);
    this.save();
    return a;
  }
  pendingApprovals() {
    return this.state.approvals.filter((a) => a.status === 'pending');
  }
  recentApprovals(n = 20) {
    return this.state.approvals.slice(0, n);
  }

  // ---- invoice metadata ----
  meta(invoiceId) {
    return this.state.invoiceMeta[invoiceId] || {};
  }
  setMeta(invoiceId, patch) {
    this.state.invoiceMeta[invoiceId] = { ...this.meta(invoiceId), ...patch };
    this.save();
  }
}

module.exports = { Store, DEMO_CUSTOMERS };
