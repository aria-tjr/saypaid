'use strict';
// The voice agent: an LLM with tool calling (OpenAI-compatible or Anthropic), plus an
// offline rule-based fallback so the app runs with zero keys.
const { offlinePlan, detectLang } = require('./offline-agent');

function systemPrompt(cfg) {
  const b = cfg.business;
  const today = new Date().toISOString().slice(0, 10);
  return [
    `You are SayPaid, the hands-free back-office assistant of "${b.name}", a small trade business. Today is ${today}.`,
    `The owner talks to you right after a job (in the van, on site, hands dirty). Turn what they say into PayPal invoices and help them get paid.`,
    `Business defaults: currency ${b.currency}, VAT ${b.taxRate}% added on top of net prices, usual hourly rate ${b.hourlyRate} ${b.currency}, payment term ${b.paymentTermDays} days.`,
    `Rules:`,
    `- Labour goes in as unit HOURS, parts/materials/call-out fees as QUANTITY. Spoken prices are NET unless the owner says "including VAT" (then divide by ${1 + b.taxRate / 100}).`,
    `- If the hourly rate is not mentioned, use ${b.hourlyRate}. Never invent items or prices that were not said.`,
    `- Use draft_invoice for new invoices. It creates a PayPal draft and queues it for the owner's signature. You CANNOT send, remind, cancel or record payments yourself: you can only propose; the owner approves on screen.`,
    `- Never say an invoice was sent or paid unless a tool result says so. After proposing, say that it is waiting for their approval.`,
    `- If a tool says a customer email is needed, ask for it. If a proposal is blocked, explain the reason plainly.`,
    `- Always use a tool: "who owes me" / "what's open" -> list_invoices(status "open" or "overdue"); reminders -> propose_reminder; cash or bank transfer received -> propose_record_payment; totals -> get_summary.`,
    `- "Bill X" or "Invoice X" means: create an invoice for customer X (the word Bill is not part of the name).`,
    `- Item descriptions must name the actual work or part (e.g. "Espresso machine repair", "Pump gasket"), never just "Labour".`,
    `- Copy every number exactly as spoken (hours, rates, prices). Words like "seventy" mean 70.`,
    `- Replies are read aloud: maximum two short sentences, no markdown, no lists, no emoji. Mention customer names and amounts from the tool result.`,
    `- The owner may speak English or German. Reply in the SAME language as the owner's last message (German input -> German reply, informal "du"). Keep German item descriptions in German.`,
  ].join('\n');
}

// Deterministic honesty check on the model's final sentence. The model's words are never trusted
// over what the tools actually did: blocked actions are always reported, invented actions are replaced.
function truthGuard(reply, steps, lang = 'en') {
  if (reply && reply.help) return reply.help;
  const de = lang === 'de';
  const results = steps.map((s) => s.result || {});
  const created = results.filter((r) => r.approval_id || r.approval?.approval_id);
  const blocked = results.flatMap((r) => (r.blocked ? r.reasons : r.approval?.blocked ? r.approval.reasons : []));
  let out = String(reply || '').replace(/\s+/g, ' ').trim();
  const sentences = out.match(/.*?[.!?](?=\s|$)/g) || [out];
  if (sentences.length > 3) out = sentences.slice(0, 3).map((x) => x.trim()).join(' ');
  if (blocked.length && !created.length) return (de ? 'Von einer Schutzregel blockiert: ' : 'Blocked by a guardrail: ') + blocked[0];
  if (!steps.length) return de ? 'Ich habe nichts ausgeführt. Sag es bitte noch einmal, z. B. „Rechnung an …“ oder „Wer schuldet mir Geld?“.' : 'I did not take any action. Please say it again, for example: invoice a customer, who owes me money, or remind a customer.';
  const CLAIM = /(queued|waiting for your (approval|signature)|ready for your approval|awaiting your|has been sent|was sent|wartet auf (deine|ihre) (freigabe|genehmigung|bestätigung)|wurde (gesendet|verschickt|versendet))/i;
  if (!created.length && CLAIM.test(out)) {
    const keep = (out.match(/.*?[.!?](?=\s|$)/g) || [out]).map((x) => x.trim()).filter((x) => x && !CLAIM.test(x));
    if (keep.length) return keep.join(' ');
    return (de ? 'Es wurde nichts vorbereitet. ' : 'No action was queued. ') + (results.find((r) => r.error)?.error || results.find((r) => r.needs)?.message || (de ? 'Bitte nenne den Kunden.' : 'Please try again with the customer name.'));
  }
  return out;
}

class Agent {
  constructor({ config, backoffice }) {
    this.cfg = config;
    this.bo = backoffice;
    this.sessions = new Map();
  }

  describe() {
    const l = this.cfg.llm;
    if (l.provider === 'openai') return { provider: 'openai-compatible', model: l.openaiModel, label: l.label || `${l.openaiModel} (OpenAI-compatible API)` };
    if (l.provider === 'anthropic') return { provider: 'anthropic', model: l.anthropicModel, label: l.label || `${l.anthropicModel} (Anthropic)` };
    return { provider: 'offline', model: 'rules', label: 'Offline rule parser (no LLM)' };
  }

  history(sessionId) {
    if (!this.sessions.has(sessionId)) this.sessions.set(sessionId, []);
    return this.sessions.get(sessionId);
  }

  async handle(sessionId, text) {
    const t0 = Date.now();
    const steps = [];
    const runTool = async (name, args) => {
      const result = await this.bo.callTool(name, args, { transcript: text, lang: detectLang(text) });
      steps.push({ tool: name, args, result });
      return result;
    };
    let reply;
    let engine = this.describe();
    let notice = null;
    const p = this.cfg.llm.provider;
    try {
      if (p === 'openai') reply = await this.runOpenAI(sessionId, text, runTool);
      else if (p === 'anthropic') reply = await this.runAnthropic(sessionId, text, runTool);
      else reply = await this.runOffline(text, runTool);
    } catch (e) {
      // Model endpoint unreachable or erroring: degrade to the deterministic parser instead of failing the owner.
      if (steps.length) throw e;
      notice = `AI model unavailable (${e.message.slice(0, 120)}). Used the offline parser instead.`;
      engine = { provider: 'offline', model: 'rules', label: 'Offline parser (fallback)' };
      reply = await this.runOffline(text, runTool);
    }
    reply = truthGuard(reply, steps, detectLang(text));
    return { reply, steps, ms: Date.now() - t0, engine, notice, lang: detectLang(text) };
  }

  // ------------------------------------------------------------ OpenAI-compatible
  async runOpenAI(sessionId, text, runTool) {
    const l = this.cfg.llm;
    const hist = this.history(sessionId);
    hist.push({ role: 'user', content: text });
    const tools = this.bo.toolDefinitions().map((t) => ({ type: 'function', function: t }));
    const lang = detectLang(text) === 'de' ? 'German (informal du)' : 'English';
    const messages = [{ role: 'system', content: systemPrompt(this.cfg) + `\nThe owner's latest message is in ${lang}. Your final reply MUST be in ${lang}, even if earlier messages used another language.` }, ...hist.slice(-4)];
    for (let i = 0; i < 6; i++) {
      const res = await fetch(`${l.openaiBaseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(l.openaiKey ? { Authorization: `Bearer ${l.openaiKey}` } : {}) },
        // First step must be a tool call: the model may not answer a money question from memory.
        body: JSON.stringify({ model: l.openaiModel, messages, tools, tool_choice: i === 0 ? 'required' : 'auto', temperature: 0.1, max_tokens: 400, frequency_penalty: 0.5 }),
      });
      if (!res.ok) throw new Error(`LLM error ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const msg = (await res.json()).choices[0].message;
      if (!msg.tool_calls?.length && i === 0) {
        // Some local models ignore tool_choice=required. Never let them answer a money question from memory.
        messages.push({ role: 'system', content: 'You answered without calling a tool. Call the appropriate tool now. Do not claim anything that a tool did not return.' });
        continue;
      }
      messages.push(msg);
      if (!msg.tool_calls?.length) {
        const out = (msg.content || '').trim();
        hist.push({ role: 'assistant', content: out });
        return out;
      }
      for (const call of msg.tool_calls) {
        let args = {};
        try { args = JSON.parse(call.function.arguments || '{}'); } catch { args = {}; }
        const result = await runTool(call.function.name, args);
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
      }
    }
    return 'I could not finish that request. Please try again.';
  }

  // ------------------------------------------------------------ Anthropic
  async runAnthropic(sessionId, text, runTool) {
    const l = this.cfg.llm;
    const hist = this.history(sessionId);
    hist.push({ role: 'user', content: text });
    const tools = this.bo.toolDefinitions().map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
    const messages = hist.slice(-4).map((m) => ({ role: m.role, content: m.content }));
    for (let i = 0; i < 6; i++) {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': l.anthropicKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: l.anthropicModel, max_tokens: 1024, system: systemPrompt(this.cfg) + `\nReply in ${detectLang(text) === 'de' ? 'German (informal du)' : 'English'}.`, tools, tool_choice: i === 0 ? { type: 'any' } : { type: 'auto' }, messages }),
      });
      if (!res.ok) throw new Error(`LLM error ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const j = await res.json();
      messages.push({ role: 'assistant', content: j.content });
      const uses = j.content.filter((c) => c.type === 'tool_use');
      if (!uses.length) {
        const out = j.content.filter((c) => c.type === 'text').map((c) => c.text).join(' ').trim();
        hist.push({ role: 'assistant', content: out });
        return out;
      }
      const results = [];
      for (const u of uses) results.push({ type: 'tool_result', tool_use_id: u.id, content: JSON.stringify(await runTool(u.name, u.input || {})) });
      messages.push({ role: 'user', content: results });
    }
    return 'I could not finish that request. Please try again.';
  }

  // ------------------------------------------------------------ Offline
  async runOffline(text, runTool) {
    const plan = offlinePlan(text, this.cfg);
    if (!plan.tool) return { help: plan.help };
    const result = await runTool(plan.tool, plan.args);
    return plan.say(result);
  }
}

module.exports = { Agent, systemPrompt, truthGuard };
