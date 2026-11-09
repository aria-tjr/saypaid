'use strict';
// Tiny .env loader (no dependencies) + typed config.
const fs = require('node:fs');
const path = require('node:path');

function loadDotEnv(file = path.join(__dirname, '..', '.env')) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2];
    if (/^".*"$|^'.*'$/.test(v)) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}
loadDotEnv();

const num = (v, d) => (v === undefined || v === '' || isNaN(Number(v)) ? d : Number(v));
const env = process.env;

function build() {
  return {
    port: num(env.PORT, 3000),
    dataDir: env.SAYPAID_DATA_DIR || path.join(__dirname, '..', 'data'),
    paypal: {
      mode: (env.PAYPAL_MODE || 'mock').toLowerCase(),
      clientId: env.PAYPAL_CLIENT_ID || '',
      clientSecret: env.PAYPAL_CLIENT_SECRET || '',
      webhookId: env.PAYPAL_WEBHOOK_ID || '',
      baseUrl: env.PAYPAL_BASE_URL || 'https://api-m.sandbox.paypal.com',
    },
    llm: {
      provider: (env.LLM_PROVIDER || 'offline').toLowerCase(),
      openaiKey: env.OPENAI_API_KEY || '',
      openaiBaseUrl: (env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, ''),
      openaiModel: env.OPENAI_MODEL || 'gpt-4o-mini',
      anthropicKey: env.ANTHROPIC_API_KEY || '',
      anthropicModel: env.ANTHROPIC_MODEL || 'claude-sonnet-4-5',
      label: env.LLM_LABEL || '',
    },
    business: {
      name: env.BUSINESS_NAME || 'Demo Repair Workshop',
      currency: env.BUSINESS_CURRENCY || 'EUR',
      taxRate: num(env.BUSINESS_TAX_RATE, 19),
      hourlyRate: num(env.BUSINESS_HOURLY_RATE, 65),
      paymentTermDays: num(env.PAYMENT_TERM_DAYS, 14),
    },
    policy: {
      softLimit: num(env.SOFT_LIMIT, 1000),
      hardLimit: num(env.HARD_LIMIT, 5000),
      reminderCooldownDays: num(env.REMINDER_COOLDOWN_DAYS, 3),
      duplicateWindowDays: 7,
      rateDeviation: 0.5,
    },
  };
}

module.exports = { build, loadDotEnv };
