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
const stats = { runs: 0, imaged: 0, imageTokens: 0, textCharsImaged: 0, failed: 0 };

// Packaged: <resources>/app.asar.unpacked holds engine/, vendor/ and node_modules/@napi-rs.
function root() {
  const here = path.resolve(__dirname, '..');
  return here.includes('app.asar') ? here.replace('app.asar', 'app.asar.unpacked') : here;
}

// Anonymous install token: random, made once, kept in the app's config. The server stores only its hash.
function installToken(cfg) {
  if (!/^fi_[A-Za-z0-9_-]{24,64}$/.test(cfg.installToken || '')) cfg.installToken = 'fi_' + crypto.randomBytes(24).toString('base64url');
  return cfg.installToken;
}

function setup(cfg) {
  fs.mkdirSync(CACHE, { recursive: true });
  fs.writeFileSync(JUDGE_FLAG, JUDGE_URL + '\n');
  if (cfg.shareSignals === false) fs.rmSync(SIGNAL_FLAG, { force: true });
  else fs.writeFileSync(SIGNAL_FLAG, 'app\n');
  const r = root();
  process.env.FICHE_SDK = r;
  process.env.FICHE_FONT_KR = path.join(r, 'vendor', 'NotoSansKR.ttf');
  // Judge auth: the anonymous install token (no sign-in in the app).
  process.env.FICHE_JUDGE_TOKEN = installToken(cfg);
}

function load() {
  if (mod) return Promise.resolve(mod);
  loading ||= import(pathToFileURL(path.join(root(), 'engine', 'v0.mjs')).href)
    .then(m => { m.setNet?.(net.request); return (mod = m); })
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
  let payload;
  try { payload = JSON.parse(buf.toString('utf8')); } catch { return null; }
  try {
    const E = await load();
    const before = meter.estPayload(payload), label = projectOf(payload), t0 = Date.now();
    const st = await E.applyV0(payload);
    if (st && !st.skipped) { try { meter.record({ before, after: meter.estPayload(payload), st, model: payload.model, ms: Date.now() - t0, label }); } catch { } }
    stats.runs++;
    if (!st || st.skipped || !(st.imaged || st.movedInputs || st.movedReplies || st.cleared)) return null;
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

module.exports = { flush, setup, compress, load, stats, info: () => ({ judge: JUDGE_URL, root: root(), loaded: !!mod, lastError, signals: fs.existsSync(SIGNAL_FLAG) }) };
