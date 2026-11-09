'use strict';
// Builds PayPal Invoicing v2 payloads and normalises PayPal invoice objects for the UI.
const { invoiceTotals, toCents } = require('./money');

const isoDate = (d) => d.toISOString().slice(0, 10);
const addDays = (d, n) => new Date(d.getTime() + n * 86400000);

function splitName(full) {
  const parts = String(full || '').trim().split(/\s+/);
  if (parts.length < 2) return { given_name: parts[0] || 'Customer', surname: '' };
  return { given_name: parts.slice(0, -1).join(' '), surname: parts[parts.length - 1] };
}

/**
 * proposal: { customer:{name,company,email}, items:[{description,quantity,unit_price,unit}], due_in_days, note, invoice_number }
 */
function buildInvoicePayload(proposal, business, now = new Date()) {
  const currency = business.currency;
  const invDate = proposal.invoice_date ? new Date(proposal.invoice_date + 'T12:00:00Z') : now;
  const due = proposal.due_date || isoDate(addDays(invDate, Number(proposal.due_in_days || business.paymentTermDays)));
  const payload = {
    detail: {
      currency_code: currency,
      invoice_date: isoDate(invDate),
      payment_term: { due_date: due },
      note: proposal.note || 'Thank you for your business!',
      memo: 'Created by SayPaid voice agent (human-approved before sending).',
    },
    invoicer: { business_name: business.name },
    primary_recipients: [
      {
        billing_info: {
          name: splitName(proposal.customer.name),
          business_name: proposal.customer.company || undefined,
          email_address: proposal.customer.email,
        },
      },
    ],
    items: proposal.items.map((it) => ({
      name: String(it.description).slice(0, 200),
      quantity: String(Number(it.quantity)),
      unit_amount: { currency_code: currency, value: (toCents(it.unit_price) / 100).toFixed(2) },
      unit_of_measure: it.unit === 'HOURS' ? 'HOURS' : 'QUANTITY',
      ...(business.taxRate ? { tax: { name: 'VAT', percent: String(business.taxRate) } } : {}),
    })),
    configuration: { allow_tip: false, tax_calculated_after_discount: true, tax_inclusive: false },
  };
  if (proposal.invoice_number) payload.detail.invoice_number = proposal.invoice_number;
  return payload;
}

function expectedTotals(proposal, business) {
  return invoiceTotals(proposal.items, business.taxRate);
}

const OPEN = new Set(['SENT', 'UNPAID', 'PARTIALLY_PAID', 'SCHEDULED']);
const PAID = new Set(['PAID', 'MARKED_AS_PAID']);
const REFUNDED = new Set(['REFUNDED', 'PARTIALLY_REFUNDED', 'MARKED_AS_REFUNDED']);

function normalize(inv, today = new Date()) {
  const r = (inv.primary_recipients || [])[0]?.billing_info || {};
  const name = [r.name?.given_name, r.name?.surname].filter(Boolean).join(' ');
  const due = inv.detail?.payment_term?.due_date || null;
  const status = inv.status;
  const overdue = OPEN.has(status) && due && due < isoDate(today);
  const c = (m) => (m?.value != null ? toCents(m.value) : 0);
  const total = c(inv.amount);
  const meta = inv.detail?.metadata || {};
  const daysOverdue = overdue ? Math.floor((today - new Date(due + 'T23:59:59Z')) / 86400000) + 1 : 0;
  return {
    id: inv.id,
    number: inv.detail?.invoice_number,
    status,
    display_status: overdue ? 'OVERDUE' : status,
    overdue: !!overdue,
    days_overdue: daysOverdue,
    customer: r.business_name || name || r.email_address,
    contact: name,
    email: r.email_address,
    business_name: inv.invoicer?.business_name,
    currency: inv.detail?.currency_code || inv.amount?.currency_code,
    subtotal_cents: c(inv.amount?.breakdown?.item_total),
    tax_cents: c(inv.amount?.breakdown?.tax_total),
    total_cents: total,
    due_cents: inv.due_amount ? c(inv.due_amount) : OPEN.has(status) ? total : 0,
    paid_cents: c(inv.payments?.paid_amount),
    refunded_cents: c(inv.refunds?.refund_amount),
    invoice_date: inv.detail?.invoice_date,
    due_date: due,
    note: inv.detail?.note || '',
    payer_url: meta.recipient_view_url || null,
    invoicer_url: meta.invoicer_view_url || null,
    created_at: meta.create_time || null,
    sent_at: meta.first_sent_time || meta.last_sent_time || null,
    reminded_at: meta.last_reminder_time || null,
    items: (inv.items || []).map((i) => ({
      name: i.name,
      quantity: Number(i.quantity),
      unit_price: Number(i.unit_amount?.value),
      unit: i.unit_of_measure,
    })),
    payments: (inv.payments?.transactions || []).map((t) => ({ id: t.payment_id, type: t.type, method: t.method, date: t.payment_date, cents: c(t.amount) })),
    refunds: (inv.refunds?.transactions || []).map((t) => ({ id: t.refund_id, method: t.method, date: t.refund_date, cents: c(t.amount) })),
    paid_at: inv.payments?.transactions?.slice(-1)[0]?.payment_date || null,
  };
}

module.exports = { buildInvoicePayload, expectedTotals, normalize, isoDate, addDays, splitName, OPEN, PAID, REFUNDED };
