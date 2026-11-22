// Child process for src/preview.js: replays past Claude Code transcripts through the engine to show what
// they would have cost with fiche. Runs with its own HOME (the engine's state, page cache and judge
// answers stay in a throwaway folder) and FICHE_PREVIEW=1 (the judge answers for free, keeps nothing).
// Judge requests go through the parent over IPC, so they show up in the app's "보낸 기록" like any other.
//
//   job file (argv[2]): { engine, files: [{ file, sid, label }] }
//   messages to the parent: { net }, { session }, { capped }, { done }, { error }
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const meter = require('./meter');
const job = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const send = m => process.send?.(m);

// Weights toward the 5-hour limit, in cache-write tokens (bench/quota, 11-14: ~51k written or ~2.8M read per 1%).
// Uncached input counts 0.8 of a write and output 5x an input token, as in bench/dogfood/quota.py.
const READ_W = 1 / 55, INPUT_W = 0.8, OUTPUT_W = 4;
// A real cache break: the request read less than half of what the previous one had in the conversation.
const BREAK = 0.5;
const SYSTEM = "You are Claude Code, Anthropic's official CLI for Claude.";

let seq = 0;
const waiting = new Map();
process.on('message', m => { const w = waiting.get(m?.id); if (w) { waiting.delete(m.id); w(m); } });
const viaParent = (url, opts = {}) => new Promise((ok, fail) => {
  const id = ++seq;
  waiting.set(id, r => r.error ? fail(new Error(r.error)) : ok({ ok: r.ok, status: r.status, text: async () => r.text, json: async () => JSON.parse(r.text) }));
  send({ net: { id, url, method: opts.method || 'GET', headers: opts.headers || {}, body: typeof opts.body === 'string' ? opts.body : undefined } });
});

function lines(file) {
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

// The conversation as Claude Code sent it for one assistant reply: walk the parent links back to the
// last compaction, then merge consecutive same-role entries the way the API sees them.
function build(by, e) {
  const chain = []; let p = e.parentUuid, guard = 0;
  while (p && by.has(p) && guard++ < 50000) {
    const x = by.get(p);
    if (x.type === 'system' && x.subtype === 'compact_boundary') break;
    chain.push(x); p = x.parentUuid;
  }
  chain.reverse();
  const msgs = [];
  const add = (role, blocks) => { const last = msgs[msgs.length - 1]; if (last && last.role === role) last.content.push(...blocks); else msgs.push({ role, content: [...blocks] }); };
  for (const x of chain) {
    if (x.type === 'attachment') {
      const a = x.attachment || {};
      if (a.type !== 'prompt_snapshot') add('user', [{ type: 'text', text: '<system-reminder>\n' + JSON.stringify(a) + '\n</system-reminder>' }]);
      continue;
    }
    const xm = x.message;
    if (!xm || !['user', 'assistant'].includes(x.type) || xm.id === e.message.id) continue;
    let c = typeof xm.content === 'string' ? [{ type: 'text', text: xm.content }] : (xm.content || []);
    c = c.filter(b => b && b.type !== 'thinking' && b.type !== 'redacted_thinking');
    if (c.length) add(x.type, structuredClone(c));
  }
  return msgs.length && msgs[msgs.length - 1].role === 'user' ? msgs : null;
}

async function replay(E, { file, sid, label }) {
  const L = lines(file);
  const by = new Map(L.filter(e => e.uuid).map(e => [e.uuid, e]));
  const seen = new Set(), reqs = [];
  for (const e of L) {
    const m = e.message;
    if (e.type !== 'assistant' || !m?.usage || seen.has(m.id) || m.model === '<synthetic>' || e.isSidechain) continue;
    seen.add(m.id);
    reqs.push({ t: Date.parse(e.timestamp), e, model: m.model });
  }
  reqs.sort((a, b) => a.t - b.t);
  // The folder name Claude Code made from the working directory loses non-ASCII letters; the entries keep the real path.
  const cwd = L.find(e => typeof e.cwd === 'string')?.cwd;
  if (cwd) label = cwd.split(/[\\/]/).filter(Boolean).pop() || label;
  // real: what the session really cost (Claude Code's recorded usage, system prompt, tools and output included).
  // saved: what fiche would have taken off it, from the conversation part only.
  const out = { sid, label, requests: 0, first: null, last: null, before: 0, after: 0, wBefore: 0, wAfter: 0, real: 0, saved: 0, lastBefore: 0, lastAfter: 0, breaks: 0 };
  let pB = 0, pA = 0, capped = false;
  const realNow = Date.now;
  for (const r of reqs) {
    const msgs = build(by, r.e);
    if (!msgs) continue;
    const before = meter.estPayload({ messages: msgs });
    const p = { model: r.model || 'claude', max_tokens: 100, system: SYSTEM, tools: [{ name: 'Bash', description: 'Run a command', input_schema: { type: 'object', properties: {} } }],
      metadata: { user_id: JSON.stringify({ session_id: sid }) }, messages: msgs };
    Date.now = () => r.t - 2000; // cold cleanups happen where they really did
    let st;
    try { st = await E.applyV0(p); } finally { Date.now = realNow; }
    if (st?.skipped) continue;
    if (st?.refused === 'preview_cap') capped = true;
    if (st?.refused === 'preview_unsupported') throw Object.assign(new Error('the judge does not support previews'), { stop: true });
    const after = meter.estPayload({ messages: p.messages });
    // What each side writes to the prompt cache this turn: the new part, or everything after a break.
    const u = r.e.message.usage, read = u.cache_read_input_tokens || 0;
    const brokeReal = out.requests > 0 && pB > 2000 && read < BREAK * pB;
    if (brokeReal) out.breaks++;
    const wB = brokeReal ? before : Math.max(0, before - pB);
    const wA = brokeReal || st?.divOut != null ? after : Math.max(0, after - pA);
    const cB = wB + (before - wB) * READ_W, cA = wA + (after - wA) * READ_W;
    out.wBefore += cB; out.wAfter += cA;
    out.real += (u.cache_creation_input_tokens || 0) + read * READ_W + (u.input_tokens || 0) * INPUT_W + (u.output_tokens || 0) * OUTPUT_W;
    out.saved += Math.max(0, cB - cA);
    out.before += before; out.after += after; out.lastBefore = before; out.lastAfter = after;
    out.requests++; out.first ??= r.t; out.last = r.t;
    pB = before; pA = after;
  }
  for (const k of ['before', 'after', 'wBefore', 'wAfter', 'real', 'saved']) out[k] = Math.round(out[k]);
  return { out, capped };
}

try {
  const E = await import(pathToFileURL(job.engine).href);
  E.setNet?.(viaParent);
  for (const f of job.files) {
    let r;
    try { r = await replay(E, f); }
    catch (e) { if (e.stop) { send({ error: e.message }); break; } send({ session: { sid: f.sid, label: f.label, error: String(e?.message || e).slice(0, 200) } }); continue; }
    // A session cut short by the day's allowance would read as smaller savings than it had: leave it out.
    if (r.out.requests && !r.capped) send({ session: r.out });
    if (r.capped) { send({ capped: true }); break; }
  }
  send({ done: true });
} catch (e) {
  send({ error: String(e?.message || e).slice(0, 300) });
}
process.disconnect?.();
