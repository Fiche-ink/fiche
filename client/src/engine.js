// Runs the fiche v0 engine inside the app (11-17). Rendering stays on this PC; only numbers go out:
// block shape numbers to the judge, and (unless the user turns "사용 통계 보내기" off) failure signals.
// Paths: engine/v0.mjs and vendor/ fonts ship next to the app (unpacked from asar so the canvas
// native module and fonts load from disk). Work files live in ~/.cache/fiche-cc like the S10 build.
const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto');
const { pathToFileURL } = require('url');
const meter = require('./meter');
const net = require('./net');

const JUDGE_URL = process.env.FICHE_JUDGE_URL || 'https://judge.fiche.ink';
const CACHE = path.join(os.homedir(), '.cache', 'fiche-cc');
const JUDGE_FLAG = path.join(CACHE, 'judge'), SIGNAL_FLAG = path.join(CACHE, 'signals');

let mod = null, loading = null, lastError = null;
const stats = { signedOut: 0, runs: 0, imaged: 0, imageTokens: 0, textCharsImaged: 0, failed: 0 };

// Packaged: <resources>/app.asar.unpacked holds engine/, vendor/ and node_modules/@napi-rs.
function root() {
  const here = path.resolve(__dirname, '..');
  return here.includes('app.asar') ? here.replace('app.asar', 'app.asar.unpacked') : here;
}

const KEEP = [14, 30, 0];
let keepDays = 30;
function setup(cfg, token) {
  if (KEEP.includes(cfg.keepDays)) keepDays = cfg.keepDays;
  if (mod?.CFG) mod.CFG.keepDays = keepDays;
  fs.mkdirSync(CACHE, { recursive: true });
  fs.writeFileSync(JUDGE_FLAG, JUDGE_URL + '\n');
  // One switch (handoff 4.3): data contribution. On, the engine sends outcome signals and the
  // shape sequence; off, the judge still decides (it has to) but keeps nothing for learning.
  // Only a real setting touches the flag: `fiche doctor` runs setup({}) and must not change it.
  if (cfg.contrib === false) fs.rmSync(SIGNAL_FLAG, { force: true });
  else if (cfg.contrib === true) fs.writeFileSync(SIGNAL_FLAG, 'app\n');
  const r = root();
  // The app signs in with its own fiche key; never fall back to the gh CLI's token (S10 dev only).
  process.env.FICHE_NO_GH_TOKEN = '1';
  process.env.FICHE_SDK = r;
  process.env.FICHE_FONT_KR = path.join(r, 'vendor', 'NotoSansKR.ttf');
  setToken(token);
}
// Judge auth: the fiche API key of the signed-in account (handoff 3: sign-in is required).
// Signed out, compress() is not called at all and requests go out untouched.
function setToken(token) {
  if (token) process.env.FICHE_JUDGE_TOKEN = token; else delete process.env.FICHE_JUDGE_TOKEN;
}

function load() {
  if (mod) return Promise.resolve(mod);
  loading ||= import(pathToFileURL(path.join(root(), 'engine', 'v0.mjs')).href)
    .then(m => { if (m.CFG) m.CFG.keepDays = keepDays; m.setNet?.(net.request); return (mod = m); })
    .catch(e => { lastError = 'engine load: ' + (e?.message || e); loading = null; throw e; });
  return loading;
}

// Compresses one /v1/messages body (Buffer). Returns the new Buffer, or null to send the original.
// Project folder name for the session list (stays on this PC): Claude Code puts the working directory in the system prompt.
function projectOf(p) {
  // Claude Code states the working directory in the system prompt or in the first user message's reminder.
  const texts = [];
  const add = c => { if (typeof c === 'string') texts.push(c.slice(0, 20000)); else if (Array.isArray(c)) for (const b of c) if (b?.type === 'text') texts.push(String(b.text).slice(0, 20000)); };
  add(p?.system);
  const first = (p?.messages || []).find(m => m.role === 'user');
  if (first) add(first.content);
  for (const t of texts) {
    const m = /Primary working directory:\s*([^\n]+)/.exec(t);
    if (m) return m[1].trim().split(/[\\/]/).filter(Boolean).pop() || null;
  }
  return null;
}

async function compress(buf) {
  // Signed out: nothing is compressed, the request goes upstream untouched (decisions come only from
  // the judge server, which needs the account).
  if (!process.env.FICHE_JUDGE_TOKEN) { stats.signedOut++; return null; }
  let payload;
  try { payload = JSON.parse(buf.toString('utf8')); } catch { return null; }
  try {
    const E = await load();
    const before = meter.estPayload(payload), fixed = meter.estFixed(payload), label = projectOf(payload), t0 = Date.now();
    const st = await E.applyV0(payload);
    const changed = st && !st.skipped && (st.imaged || st.movedInputs || st.movedReplies || st.cleared);
    // Unchanged requests go upstream as the original bytes, so they are metered at their original size.
    if (st && !st.skipped) { try { meter.record({ before, fixed, after: changed ? meter.estPayload(payload) : before, st, model: payload.model, ms: Date.now() - t0, label }); } catch { } }
    stats.runs++;
    if (!changed) return null;
    stats.imaged += st.imaged || 0; stats.imageTokens += st.imageTokens || 0; stats.textCharsImaged += st.textCharsImaged || 0;
    return Buffer.from(JSON.stringify(payload));
  } catch (e) {
    stats.failed++; lastError = String(e?.message || e).slice(0, 300);
    return null;
  }
}

// Queued outcome signals go up every 5 minutes and once more at quit.
function flush() { return mod?.flushSignals ? mod.flushSignals().catch(() => {}) : Promise.resolve(); }
setInterval(flush, 5 * 60e3).unref?.();

// Most recently rendered page PNG from the local cache (stays on this PC; never sent to fiche).
function latestPage() {
  const dir = path.join(CACHE, 'v0', 'png');
  try {
    let best = null;
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      const full = path.join(dir, name);
      const st = fs.statSync(full);
      if (st.size > 4 * 1024 * 1024) continue;
      if (!best || st.mtimeMs > best.mtimeMs) best = { full, mtimeMs: st.mtimeMs };
    }
    if (!best) return null;
    const pages = JSON.parse(fs.readFileSync(best.full, 'utf8'));
    const p = Array.isArray(pages) ? pages[0] : null;
    if (!p?.b64 || !p.w || !p.h) return null;
    return {
      dataUrl: 'data:image/png;base64,' + p.b64,
      width: p.w, height: p.h,
      tokens: Math.ceil(p.w / 28) * Math.ceil(p.h / 28) + 3,
      bytes: Math.floor((p.b64.length * 3) / 4),
      pages: pages.length,
      at: best.mtimeMs,
    };
  } catch { return null; }
}

module.exports = { flush, setup, setToken, compress, load, latestPage, stats, info: () => ({ judge: JUDGE_URL, root: root(), loaded: !!mod, lastError, signals: fs.existsSync(SIGNAL_FLAG) }) };
