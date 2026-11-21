// Savings meter: estimates how many input tokens each request would have been without fiche (before)
// and what was actually sent (after), and keeps per-day / per-session totals for the UI.
// Token counts are estimates (same calibration as bench/dogfood/replay.mjs: code ~0.503 tok/char,
// Korean-heavy text ~0.821 tok/char, images (w/28)*(h/28)+3), so the UI labels them as estimates.
const fs = require('fs'), path = require('path');
const { EventEmitter } = require('events');

const CJK = /[ᄀ-ᇿ぀-ヿ㄰-㆏㐀-鿿가-힯]/;
const LETTER = /\p{L}/u;
function rate(t) {
  let c = 0, n = 0;
  for (const ch of t.slice(0, 3000)) { if (CJK.test(ch)) c++; else if (LETTER.test(ch)) n++; }
  return c / (c + n || 1) > 0.15 ? 0.821 : 0.503;
}
const txt = t => (t ? Math.round(t.length * rate(t)) : 0);
function imgTok(b) {
  try {
    const buf = Buffer.from(String(b.source?.data || '').slice(0, 64), 'base64');
    if (buf.toString('latin1', 12, 16) !== 'IHDR') return 1600;
    const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
    if (w > 20000 || h > 20000) return 1600;
    return Math.ceil(w / 28) * Math.ceil(h / 28) + 3;
  } catch { return 1600; }
}
function blocks(content) {
  return typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
}
function estBlock(b) {
  if (!b || typeof b !== 'object') return 0;
  if (b.type === 'text') return txt(b.text);
  if (b.type === 'image') return imgTok(b);
  if (b.type === 'tool_use') return txt(JSON.stringify(b.input ?? {}));
  if (b.type === 'tool_result') return blocks(b.content).reduce((s, x) => s + estBlock(x), 0);
  if (b.type === 'thinking') return txt(b.thinking);
  return 0;
}
// Whole request as the model sees it: system + tool definitions + messages.
function estPayload(p) {
  let t = 0;
  for (const s of blocks(p?.system)) t += estBlock(s);
  if (Array.isArray(p?.tools)) t += txt(JSON.stringify(p.tools));
  for (const m of p?.messages || []) for (const b of blocks(m.content)) t += estBlock(b);
  return t;
}
// System prompt + tool definitions. fiche leaves these as they are, so the savings rate shown to the
// user is taken over the conversation part only (11-22: a 150k first turn with ~140k fixed read as -0%).
function estFixed(p) {
  let t = 0;
  for (const s of blocks(p?.system)) t += estBlock(s);
  if (Array.isArray(p?.tools)) t += txt(JSON.stringify(p.tools));
  return t;
}

const day = at => new Date(at).toLocaleDateString('sv-SE'); // YYYY-MM-DD, local time
const emitter = new EventEmitter();
let file = null, data = { days: {}, sessions: {} }, recent = [], saveTimer = null;

function init(dir) {
  file = path.join(dir, 'stats.json');
  try { data = { days: {}, sessions: {}, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch { }
}
function save() {
  if (!file || saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    // Keep 90 days and the 200 most recent sessions.
    const days = Object.keys(data.days).sort();
    for (const d of days.slice(0, Math.max(0, days.length - 90))) delete data.days[d];
    const ss = Object.entries(data.sessions).sort((a, b) => b[1].last - a[1].last);
    for (const [k] of ss.slice(200)) delete data.sessions[k];
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(data)); } catch { }
  }, 3000);
}

// One request went through the engine. `st` is the engine's stats object.
function record({ before, after, fixed, st, model, ms, label }) {
  const at = Date.now(), saved = Math.max(0, before - after);
  const fx = Math.max(0, Math.min(fixed || 0, before, after)), convBefore = before - fx, convAfter = after - fx;
  const r = {
    at, model: model || null, before, after, saved, convBefore, convAfter, ms: ms || 0,
    imaged: st?.imaged || 0, movedInputs: st?.movedInputs || 0, movedReplies: st?.movedReplies || 0,
    cleared: st?.cleared || 0, images: st?.images || 0, conv: st?.conv || null, issue: st?.judgeStatus ? String(st.judgeStatus) : st?.refused || null,
  };
  recent.unshift(r); if (recent.length > 200) recent.pop();
  const d = (data.days[day(at)] ||= { before: 0, after: 0, requests: 0, imaged: 0 });
  d.before += before; d.after += after; d.convBefore = (d.convBefore || 0) + convBefore; d.convAfter = (d.convAfter || 0) + convAfter; d.requests++; d.imaged += r.imaged; // 11-18: pages drawn for the first time (not every page re-sent each turn), and their pixels.
  d.pages = (d.pages || 0) + (st?.drawn || 0); d.px = (d.px || 0) + (st?.drawnPx || 0);
  if (r.conv) {
    const s = (data.sessions[r.conv] ||= { first: at, last: at, before: 0, after: 0, requests: 0, imaged: 0, lastBefore: 0, lastAfter: 0 });
    s.last = at; s.before += before; s.after += after; s.convBefore = (s.convBefore || 0) + convBefore; s.convAfter = (s.convAfter || 0) + convAfter; s.requests++; s.imaged += r.imaged; s.lastBefore = before; s.lastAfter = after; s.lastConvBefore = convBefore; s.lastConvAfter = convAfter; s.model = r.model; s.pages = r.images; if (label) s.label = label;
  }
  save();
  emitter.emit('update', r);
  return r;
}

function summary() {
  const today = day(Date.now()), month = today.slice(0, 7);
  const sum = keys => keys.reduce((a, k) => {
    const d = data.days[k];
    return { before: a.before + d.before, after: a.after + d.after, requests: a.requests + d.requests, imaged: a.imaged + d.imaged,
      convBefore: a.convBefore + (d.convBefore ?? d.before), convAfter: a.convAfter + (d.convAfter ?? d.after) };
  }, { before: 0, after: 0, requests: 0, imaged: 0, convBefore: 0, convAfter: 0 });
  const days14 = [];
  for (let i = 13; i >= 0; i--) {
    const k = day(Date.now() - i * 864e5), d = data.days[k];
    days14.push({ day: k, saved: d ? Math.max(0, d.before - d.after) : 0, before: d?.before || 0, after: d?.after || 0, convBefore: d?.convBefore ?? d?.before ?? 0, convAfter: d?.convAfter ?? d?.after ?? 0 });
  }
  const sessions = Object.entries(data.sessions).sort((a, b) => b[1].last - a[1].last).slice(0, 30).map(([id, s]) => ({ id, convBefore: s.before, convAfter: s.after, ...s }));
  // Lifetime totals for the open-beta card and the early-tester table (days kept: 90).
  const allDays = Object.keys(data.days), total = allDays.reduce((a, k) => { const d = data.days[k];
    return { requests: a.requests + (d.requests || 0), imaged: a.imaged + (d.imaged || 0), pages: a.pages + (d.pages || 0), px: a.px + (d.px || 0) }; }, { requests: 0, imaged: 0, pages: 0, px: 0 });
  const activeDays = allDays.filter(k => (data.days[k].requests || 0) > 0).length;
  // Last 7 days (today included): pixels drawn for the weekly usage report.
  const week = { px: 0, pages: 0, requests: 0 };
  for (let i = 0; i < 7; i++) {
    const d = data.days[day(Date.now() - i * 864e5)];
    if (d) { week.px += d.px || 0; week.pages += d.pages || 0; week.requests += d.requests || 0; }
  }
  return {
    estimate: true, total, activeDays, week,
    today: sum(Object.keys(data.days).filter(k => k === today)),
    month: { name: month, ...sum(Object.keys(data.days).filter(k => k.startsWith(month))) },
    days14, sessions, recent: recent.slice(0, 50), last: recent[0] || null,
  };
}

module.exports = { init, estPayload, estFixed, record, summary, on: (ev, f) => emitter.on(ev, f) };
