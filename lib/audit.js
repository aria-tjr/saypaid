'use strict';
// Append-only, hash-chained audit log. Every AI proposal, human decision and
// PayPal call is recorded; editing any past line breaks the chain.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

class AuditLog {
  constructor(dir) {
    this.file = path.join(dir, 'audit.jsonl');
    fs.mkdirSync(dir, { recursive: true });
    this.entries = fs.existsSync(this.file)
      ? fs.readFileSync(this.file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
      : [];
  }
  static hash(e) {
    const { hash, ...rest } = e;
    return crypto.createHash('sha256').update(JSON.stringify(rest)).digest('hex');
  }
  append(actor, action, details = {}) {
    const prev = this.entries.length ? this.entries[this.entries.length - 1].hash : 'GENESIS';
    const e = { seq: this.entries.length + 1, ts: new Date().toISOString(), actor, action, details, prev };
    e.hash = AuditLog.hash(e);
    this.entries.push(e);
    fs.appendFileSync(this.file, JSON.stringify(e) + '\n');
    return e;
  }
  verify() {
    let prev = 'GENESIS';
    for (const e of this.entries) {
      if (e.prev !== prev || AuditLog.hash(e) !== e.hash) return { ok: false, brokenAt: e.seq };
      prev = e.hash;
    }
    return { ok: true, length: this.entries.length, head: prev };
  }
  list(limit = 200) {
    return this.entries.slice(-limit).reverse();
  }
  reset() {
    this.entries = [];
    if (fs.existsSync(this.file)) fs.unlinkSync(this.file);
  }
}

module.exports = { AuditLog };
