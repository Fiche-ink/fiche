// "What your recent sessions would have cost with fiche" (11-23). Reads Claude Code's own transcripts
// (~/.claude/projects/*/*.jsonl) on this PC, replays them through the engine in a child process, and
// keeps only the resulting numbers (preview.json in the data folder). Runs only when the user asks.
// The transcripts never leave the PC: the judge gets the same block shape numbers as a live request,
// marked as a preview (free under a daily allowance, never stored for learning).
const fs = require('fs'), os = require('os'), path = require('path');
const { fork } = require('child_process');
const { EventEmitter } = require('events');
const net = require('./net');
const meter = require('./meter');

const DAYS = 7, MAX_SESSIONS = 30, MIN_BYTES = 20 * 1024, MAX_BYTES = 40 * 1024 * 1024;
const emitter = new EventEmitter();
let file = null, last = null, running = null;

function init(dir) {
  file = path.join(dir, 'preview.json');
  try { last = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { last = null; }
}

// Main-conversation transcripts of the last DAYS days, newest first. Subagent transcripts live one
// folder deeper (<session>/subagents/) and are not read. Sessions fiche already handled are left
// out: their real numbers are in the session list.
function transcripts(home = os.homedir()) {
  const root = path.join(home, '.claude', 'projects'), since = Date.now() - DAYS * 864e5, out = [];
  const handled = meter.sids();
  let dirs = [];
  try { dirs = fs.readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory()); } catch { return out; }
  for (const d of dirs) {
    let names = [];
    try { names = fs.readdirSync(path.join(root, d.name)); } catch { continue; }
    for (const n of names) {
      if (!n.endsWith('.jsonl')) continue;
      const full = path.join(root, d.name, n);
      let st; try { st = fs.statSync(full); } catch { continue; }
      if (!st.isFile() || st.mtimeMs < since || st.size < MIN_BYTES || st.size > MAX_BYTES) continue;
      const sid = n.slice(0, -6);
      if (handled.has(sid)) continue;
      out.push({ file: full, sid, label: label(d.name), at: st.mtimeMs });
    }
  }
  return out.sort((a, b) => b.at - a.at).slice(0, MAX_SESSIONS);
}
// Claude Code names the folder after the working directory with every separator turned into "-".
const label = dir => dir.split('-').filter(Boolean).pop() || dir;

// The judge allows 240 calls a minute per account (previews on their own bucket). A run over 30 sessions
// makes several hundred, and a refused call would quietly count as no savings, so calls go one at a time,
// at most one per GAP_MS, and a 429 waits and tries again.
const GAP_MS = 300, RETRIES = 4;
let chain = Promise.resolve(), lastCall = 0;
function paced(call) {
  const go = async () => {
    for (let i = 0; ; i++) {
      const wait = lastCall + GAP_MS - Date.now();
      if (wait > 0) await new Promise(r => setTimeout(r, wait));
      lastCall = Date.now();
      const r = await call();
      if (r.status !== 429 || i >= RETRIES) return r;
      await new Promise(ok => setTimeout(ok, 2000 * (i + 1)));
    }
  };
  const p = chain.then(go, go);
  chain = p.catch(() => { });
  return p;
}

function engineFile(root) { return path.join(root, 'engine', 'v0.mjs'); }

// Starts a run unless one is going. `root` is where engine/ and vendor/ are (engine.info().root).
function run({ root, token, home, max = MAX_SESSIONS }) {
  if (running) return running;
  if (!token) return Promise.resolve({ error: 'signed_out' });
  const files = transcripts(home).slice(0, max);
  const box = fs.mkdtempSync(path.join(os.tmpdir(), 'fiche-preview-'));
  const cache = path.join(box, '.cache', 'fiche-cc');
  fs.mkdirSync(cache, { recursive: true });
  fs.writeFileSync(path.join(cache, 'judge'), (process.env.FICHE_JUDGE_URL || 'https://judge.fiche.ink') + '\n');
  const jobFile = path.join(box, 'job.json');
  fs.writeFileSync(jobFile, JSON.stringify({ engine: engineFile(root), files: files.map(({ file, sid, label }) => ({ file, sid, label })) }));
  const res = { at: Date.now(), days: DAYS, found: files.length, sessions: [], capped: false, error: null, done: false };
  emitter.emit('update', { ...res, running: true });
  if (!files.length) { res.done = true; return finish(res, box); }
  // Only what the engine needs: its own HOME, the account key, the fonts. Nothing else of this PC's environment.
  const env = {
    ELECTRON_RUN_AS_NODE: '1', FICHE_PREVIEW: '1', FICHE_NO_GH_TOKEN: '1', FICHE_JUDGE_TOKEN: token,
    FICHE_SDK: root, FICHE_FONT_KR: path.join(root, 'vendor', 'NotoSansKR.ttf'),
    HOME: box, USERPROFILE: box, APPDATA: box, LOCALAPPDATA: box, TMP: box, TEMP: box, TMPDIR: box,
    PATH: process.env.PATH || '', SystemRoot: process.env.SystemRoot || '',
  };
  running = new Promise(ok => {
    // Packaged, the child and meter.js are unpacked from the asar (package.json asarUnpack) so node can load them.
    const here = __dirname.includes('app.asar') ? __dirname.replace('app.asar', 'app.asar.unpacked') : __dirname;
    const child = fork(path.join(here, 'preview-run.mjs'), [jobFile], { env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true });
    try { os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { }
    let errText = '';
    child.stderr?.on('data', d => { errText = (errText + d).slice(-2000); });
    child.on('message', async m => {
      if (m?.net) {
        const { id, url, method, headers, body } = m.net;
        try {
          const r = await paced(() => net.request(url, { method, headers, body, signal: AbortSignal.timeout(15000) }));
          child.connected && child.send({ id, ok: r.ok, status: r.status, text: await r.text() });
        } catch (e) { child.connected && child.send({ id, error: String(e?.message || e) }); }
      } else if (m?.session) {
        if (!m.session.error) res.sessions.push(m.session);
        emitter.emit('update', { ...summarize(res), running: true });
      } else if (m?.capped) res.capped = true;
      else if (m?.error) res.error = m.error;
      else if (m?.done) res.done = true;
    });
    child.on('exit', code => {
      if (!res.done && !res.error) res.error = `stopped (${code}) ${errText.split('\n').filter(Boolean).pop() || ''}`.trim().slice(0, 300);
      ok(finish(res, box));
    });
  });
  return running;
}

function finish(res, box) {
  try { fs.rmSync(box, { recursive: true, force: true }); } catch { }
  running = null;
  last = summarize(res);
  if (file) try { fs.writeFileSync(file, JSON.stringify(last)); } catch { }
  emitter.emit('update', last);
  return last;
}

// Totals over the sessions that finished. pct: conversation tokens sent. limitPct: share of the whole limit use
// (recorded usage with system prompt, tools and output, weighted like the 5-hour limit) fiche would have saved.
function summarize(res) {
  const s = res.sessions, sum = k => s.reduce((a, x) => a + (x[k] || 0), 0);
  const before = sum('before'), after = sum('after'), wBefore = sum('wBefore'), wAfter = sum('wAfter'), real = sum('real'), saved = sum('saved');
  return {
    ...res, before, after, wBefore, wAfter, real, saved,
    pct: before ? Math.round((1 - after / before) * 100) : null,
    convLimitPct: wBefore ? Math.round((1 - wAfter / wBefore) * 100) : null,
    limitPct: real ? Math.round(Math.min(saved, real) / real * 100) : null,
  };
}

module.exports = { init, run, transcripts, get: () => (running ? { ...last, running: true } : last), on: (ev, f) => emitter.on(ev, f) };
