// fiche account in the PC app (11-18: sign-in is required again; the server decides and meters
// every block, so it has to know whose film it is).
//
// Sign-in: the system browser opens https://api.fiche.ink/auth/login?app_port=<p>&app_state=<s>,
// the user signs in with GitHub or Google there, and the server sends the browser back to
// http://127.0.0.1:<p>/callback?code=…&state=… . The app trades that one-time code at
// POST /auth/app/exchange for its own API key (fk_…). The key is kept encrypted with the
// Windows user's credentials (Electron safeStorage) in userData/account.json.
//
// Every request goes through net.request, so it shows in the app's "보낸 기록" list.
const fs = require('fs'), path = require('path'), http = require('http'), crypto = require('crypto'), os = require('os');
const { EventEmitter } = require('events');
const net = require('./net');

const API = process.env.FICHE_API || 'https://api.fiche.ink';
const JUDGE = process.env.FICHE_JUDGE_URL || 'https://judge.fiche.ink';
const emitter = new EventEmitter();

let file = null, safe = null, state = { key: null, email: null, accountId: null }, me = null, meAt = 0, meErr = null;

function init(dir, safeStorage) {
  file = path.join(dir, 'account.json'); safe = safeStorage || null;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    let key = null;
    if (raw.enc && safe?.isEncryptionAvailable?.()) key = safe.decryptString(Buffer.from(raw.enc, 'base64'));
    else if (raw.key) key = raw.key;
    if (/^fk_[A-Za-z0-9_-]{20,}$/.test(key || '')) state = { key, email: raw.email || null, accountId: raw.accountId || null };
  } catch { }
}
function save() {
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (!state.key) { fs.rmSync(file, { force: true }); return; }
    const out = { email: state.email, accountId: state.accountId };
    if (safe?.isEncryptionAvailable?.()) out.enc = safe.encryptString(state.key).toString('base64');
    else out.key = state.key;
    fs.writeFileSync(file, JSON.stringify(out, null, 2), { mode: 0o600 });
  } catch (e) { console.error('account save', e?.message); }
}

const key = () => state.key;
const signedIn = () => !!state.key;
const info = () => ({ signedIn: !!state.key, email: state.email, accountId: state.accountId, me, meErr });

async function api(method, p, body) {
  const headers = { 'content-type': 'application/json' };
  if (state.key) headers.authorization = `Bearer ${state.key}`;
  const res = await net.request(API + p, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) });
  let data = null; try { data = await res.json(); } catch { }
  if (res.status === 401 && state.key) { state = { key: null, email: null, accountId: null }; me = null; save(); emitter.emit('change', info()); }
  return { status: res.status, ok: res.ok, data };
}

// Opens the browser and waits (up to 10 minutes) for the loopback callback.
let pending = null;
function signIn(openExternal) {
  if (pending) { openExternal(pending.url); return pending.done; }
  const appState = crypto.randomBytes(18).toString('base64url');
  let srv, timer, rejectPending = null;
  const done = new Promise((ok, fail) => {
    rejectPending = fail;
    srv = http.createServer(async (req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      if (u.pathname !== '/callback') { res.writeHead(404); return res.end(); }
      const page = (title, text) => {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><meta charset="utf-8"><title>fiche</title><body style="font:16px system-ui,sans-serif;max-width:480px;margin:80px auto;padding:0 20px;color:#111"><h1 style="font-size:22px">${title}</h1><p>${text}</p></body>`);
      };
      if (u.searchParams.get('state') !== appState || !u.searchParams.get('code')) {
        page('로그인하지 못했습니다 · Sign-in failed', '앱에서 다시 시도해 주세요. · Please try again from the app.');
        return;
      }
      try {
        const r = await api('POST', '/auth/app/exchange', { code: u.searchParams.get('code'), name: `fiche desktop (${os.hostname()})`.slice(0, 60) });
        if (!r.ok || !r.data?.key) throw new Error(r.data?.error || `exchange ${r.status}`);
        state = { key: r.data.key, email: r.data.account?.email || null, accountId: r.data.account?.id || null };
        save();
        page('로그인되었습니다 · Signed in', '이 창을 닫고 fiche로 돌아가세요. · You can close this tab and go back to fiche.');
        ok(info());
      } catch (e) {
        page('로그인하지 못했습니다 · Sign-in failed', '앱에서 다시 시도해 주세요. · Please try again from the app.');
        fail(e);
      }
    });
    srv.on('error', fail);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      const url = `${API}/auth/login?app_port=${port}&app_state=${encodeURIComponent(appState)}`;
      pending.url = url;
      openExternal(url);
    });
    timer = setTimeout(() => fail(new Error('timeout')), 10 * 60e3);
  }).finally(() => { clearTimeout(timer); try { srv.close(); } catch { } pending = null; });
  pending = { done, url: null, cancel: () => rejectPending?.(new Error('cancelled')) };
  return done.then(async v => { await refresh(true).catch(() => { }); emitter.emit('change', info()); return v; });
}

function cancelSignIn() { if (pending) pending.cancel(); }

async function signOut() {
  state = { key: null, email: null, accountId: null }; me = null; meAt = 0; meErr = null; save();
  emitter.emit('change', info());
}

// GET /v1/me: film balance, plan, contribution switch, early tester progress (server counts).
async function refresh(force = false) {
  if (!state.key) return null;
  if (!force && me && Date.now() - meAt < 60e3) return me;
  let r;
  try { r = await api('GET', '/v1/me'); }
  catch (e) { meErr = String(e?.message || e); emitter.emit('change', info()); throw e; }
  meErr = r.ok && r.data ? null : `HTTP ${r.status}`;
  if (meErr) emitter.emit('change', info());
  if (r.ok && r.data) {
    me = r.data; meAt = Date.now();
    if (r.data.email && r.data.email !== state.email) { state.email = r.data.email; save(); }
    emitter.emit('change', info());
  }
  return me;
}

// Settings the server keeps per account: plan (asked once) and the data contribution switch.
async function setProfile(patch) {
  if (!state.key) return null;
  const r = await api('POST', '/v1/profile', patch);
  if (r.ok && r.data) { me = { ...(me || {}), ...r.data, film: r.data.film || me?.film }; emitter.emit('change', info()); }
  return r;
}

// Weekly usage report (handoff 4.3): plan, pixels drawn this week, and Claude's own limit readings
// (the anthropic-ratelimit-unified-* response headers, numbers only), so film sizes can be fitted to
// real plans. Only sent while data contribution is on.
async function report(body) {
  if (!state.key) return null;
  const res = await net.request(`${JUDGE}/v1/usage`, {
    method: 'POST', headers: { authorization: `Bearer ${state.key}`, 'content-type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(10000),
  });
  return res.status;
}

module.exports = { init, key, signedIn, info, signIn, cancelSignIn, signOut, refresh, setProfile, report, on: (ev, f) => emitter.on(ev, f) };
