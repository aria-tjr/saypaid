'use strict';
// Wipes local data (address book, approvals, audit log, mock PayPal state). Mock mode re-seeds on next start.
const fs = require('node:fs');
const path = require('node:path');
const dir = process.env.SAYPAID_DATA_DIR || path.join(__dirname, '..', 'data');
for (const f of ['state.json', 'audit.jsonl', 'mock-paypal.json']) {
  const p = path.join(dir, f);
  if (fs.existsSync(p)) { fs.unlinkSync(p); console.log('removed', p); }
}
console.log('Local data reset.');
