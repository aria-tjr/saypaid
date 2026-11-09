'use strict';
// Verifies your PayPal sandbox credentials and Invoicing permission without creating anything.
require('../lib/config');
const { build } = require('../lib/config');
const { PayPalClient } = require('../lib/paypal');

(async () => {
  const cfg = build();
  const pp = new PayPalClient(cfg.paypal, (t) => console.log(`  ${t.method} ${t.path} -> ${t.status} (${t.ms} ms)${t.debugId ? ' debug-id ' + t.debugId : ''}`));
  console.log('Checking PayPal sandbox at', cfg.paypal.baseUrl);
  await pp.accessToken();
  console.log('✓ OAuth token OK');
  const n = await pp.nextInvoiceNumber();
  console.log('✓ Invoicing API reachable, next invoice number:', n);
  const list = await pp.list();
  console.log(`✓ ${list.length} invoice(s) visible in this sandbox account`);
})().catch((e) => { console.error('✗', e.message); process.exit(1); });
