'use strict';
// All money math in integer cents to avoid float drift.
const toCents = (v) => Math.round(Number(v) * 100);
const fromCents = (c) => (c / 100).toFixed(2);

function invoiceTotals(items, taxRate) {
  let subtotal = 0;
  for (const it of items) subtotal += Math.round(Number(it.quantity) * toCents(it.unit_price));
  const tax = Math.round((subtotal * Number(taxRate || 0)) / 100);
  return { subtotal, tax, total: subtotal + tax };
}

function fmt(cents, currency = 'EUR') {
  try {
    return new Intl.NumberFormat('en-IE', { style: 'currency', currency }).format(cents / 100);
  } catch {
    return `${fromCents(cents)} ${currency}`;
  }
}

module.exports = { toCents, fromCents, invoiceTotals, fmt };
