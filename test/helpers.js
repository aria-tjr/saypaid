'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function freshApp(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'saypaid-'));
  process.env.SAYPAID_DATA_DIR = dir;
  process.env.PAYPAL_MODE = 'mock';
  process.env.LLM_PROVIDER = 'offline';
  process.env.MOCK_LATENCY_MS = '0';
  delete process.env.AUTOMATION_WEBHOOK_URL;
  delete require.cache[require.resolve('../lib/config')];
  delete require.cache[require.resolve('../lib/app')];
  const { createApp } = require('../lib/app');
  return createApp({ mockLatencyMs: 0, ...extra });
}
const line = (description, quantity, unit_price, unit = 'QUANTITY') => ({ description, quantity, unit_price, unit });
module.exports = { freshApp, line };
