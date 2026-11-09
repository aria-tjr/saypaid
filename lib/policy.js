'use strict';
// Deterministic guardrails. The language model can only PROPOSE money-moving actions;
// these rules run in plain code, cannot be talked around by a prompt, and decide whether a
// proposal is blocked, or which warnings a human must see before signing it off.
const { toCents, fmt } = require('./money');
const { isoDate, addDays } = require('./invoice');

function evaluate(action, ctx, cfg, now = new Date()) {
  const { policy, business } = cfg;
  const flags = [];
  const block = [];
  const cur = business.currency;

  if (action === 'send_invoice') {
    const inv = ctx.invoice;
    if (inv.status !== 'DRAFT') block.push(`Invoice is ${inv.status}, only drafts can be sent.`);
    if (inv.total_cents <= 0) block.push('Invoice total must be positive.');
    if (inv.total_cents > toCents(policy.hardLimit)) block.push(`Total ${fmt(inv.total_cents, cur)} is above the hard limit of ${fmt(toCents(policy.hardLimit), cur)}. Create it manually in PayPal if it is correct.`);
    else if (inv.total_cents > toCents(policy.softLimit)) flags.push({ level: 'warn', code: 'HIGH_AMOUNT', text: `High amount: ${fmt(inv.total_cents, cur)} (soft limit ${fmt(toCents(policy.softLimit), cur)}).` });
    const since = isoDate(addDays(now, -policy.duplicateWindowDays));
    const dup = (ctx.allInvoices || []).find((o) => o.id !== inv.id && o.email === inv.email && o.total_cents === inv.total_cents
      && o.status !== 'DRAFT' && o.status !== 'CANCELLED' && (o.invoice_date || '') >= since);
    if (dup) flags.push({ level: 'warn', code: 'POSSIBLE_DUPLICATE', text: `Possible duplicate: ${dup.number} to the same customer for the same amount on ${dup.invoice_date}.` });
    if (ctx.newRecipient) flags.push({ level: 'warn', code: 'NEW_RECIPIENT', text: `New recipient ${inv.email}: not in your address book yet. Check the spelling.` });
    for (const it of inv.items) {
      if (it.unit === 'HOURS' && business.hourlyRate) {
        const dev = Math.abs(it.unit_price - business.hourlyRate) / business.hourlyRate;
        if (dev > policy.rateDeviation) flags.push({ level: 'info', code: 'RATE_DEVIATION', text: `Hourly rate ${fmt(toCents(it.unit_price), cur)} differs from your usual ${fmt(toCents(business.hourlyRate), cur)}.` });
      }
      if (it.quantity <= 0) block.push(`Item "${it.name}" has a non-positive quantity.`);
    }
  }

  if (action === 'send_reminder') {
    const inv = ctx.invoice;
    if (!['SENT', 'UNPAID', 'PARTIALLY_PAID'].includes(inv.status)) block.push(`Invoice ${inv.number} is ${inv.status}; reminders only go to unpaid invoices.`);
    const last = ctx.meta?.reminders?.slice(-1)[0];
    if (last) {
      const days = (now - new Date(last)) / 86400000;
      if (days < policy.reminderCooldownDays) block.push(`A reminder for ${inv.number} was already sent ${days < 1 ? 'today' : Math.floor(days) + ' day(s) ago'}. Cooldown is ${policy.reminderCooldownDays} days.`);
    }
    if (!inv.overdue) flags.push({ level: 'info', code: 'NOT_OVERDUE', text: `Not overdue yet (due ${inv.due_date}).` });
  }

  if (action === 'cancel_invoice') {
    const inv = ctx.invoice;
    if (['PAID', 'MARKED_AS_PAID', 'PARTIALLY_PAID', 'REFUNDED'].includes(inv.status)) block.push(`Invoice ${inv.number} already has payments (${inv.status}); cancelling is not allowed. Issue a refund in PayPal instead.`);
    if (inv.status === 'CANCELLED') block.push(`Invoice ${inv.number} is already cancelled.`);
    if (inv.status === 'DRAFT') flags.push({ level: 'info', code: 'DRAFT', text: 'This is only a draft; nothing was sent to the customer yet.' });
  }

  if (action === 'record_payment') {
    const inv = ctx.invoice;
    const amt = toCents(ctx.amount);
    if (!['SENT', 'UNPAID', 'PARTIALLY_PAID'].includes(inv.status)) block.push(`Invoice ${inv.number} is ${inv.status}; nothing is outstanding.`);
    if (!(amt > 0)) block.push('Payment amount must be positive.');
    if (amt > inv.due_cents) block.push(`Amount ${fmt(amt, cur)} is more than the ${fmt(inv.due_cents, cur)} still due.`);
    if (amt > 0 && amt < inv.due_cents) flags.push({ level: 'info', code: 'PARTIAL', text: `Partial payment: ${fmt(inv.due_cents - amt, cur)} will remain open.` });
  }

  if (action === 'record_refund') {
    const inv = ctx.invoice;
    const amt = toCents(ctx.amount);
    const refundable = inv.paid_cents - inv.refunded_cents;
    if (!(refundable > 0)) block.push(`Invoice ${inv.number} has no payments that could be refunded.`);
    if (!(amt > 0)) block.push('Refund amount must be positive.');
    if (amt > refundable) block.push(`Refund ${fmt(amt, cur)} is more than the ${fmt(refundable, cur)} paid on ${inv.number}.`);
    if (inv.payments.some((p) => p.type === 'PAYPAL')) flags.push({ level: 'warn', code: 'PAYPAL_PAYMENT', text: 'This invoice was paid through PayPal. Recording a refund here only updates the invoice; send the money back from the PayPal transaction itself.' });
  }

  return { blocked: block.length > 0, reasons: block, flags };
}

module.exports = { evaluate };
