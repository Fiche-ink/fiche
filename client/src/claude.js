// Connects Claude Code to the local proxy by setting env.ANTHROPIC_BASE_URL in ~/.claude/settings.json.
// The first change keeps a copy as settings.json.fiche-bak. An existing ANTHROPIC_BASE_URL (another
// router) is remembered, used as the proxy's upstream, and put back on disconnect.
const fs = require('fs'), path = require('path'), os = require('os');

const FILE = path.join(os.homedir(), '.claude', 'settings.json');
const BAK = FILE + '.fiche-bak';
// Any fiche proxy address (proxy.js PORTS), so a moved port is still recognised as ours.
const FICHE_URL = /^http:\/\/127\.0\.0\.1:(47321|4733[1-9])$/;
// Claude Code's thread mode sends only new messages and keeps the history on Anthropic's side, so the proxy
// never sees (or compresses) it. "0" turns it off; the marker file says fiche added it and removes it on disconnect.
const TETHER = 'CLAUDE_CODE_TETHER_LIVE', TETHER_MARK = FILE + '.fiche-tether';
// HTTPS_PROXY mode (mitm.js) for Claude Desktop, which overrides ANTHROPIC_BASE_URL. The marker keeps the
// values these keys had before fiche, so they go back on disconnect and the old proxy and CA stay upstream.
const PROXY_KEYS = ['HTTPS_PROXY', 'https_proxy', 'NODE_EXTRA_CA_CERTS'], PROXY_MARK = FILE + '.fiche-proxy';
let mitm = null; // { ca: fiche CA file, bundle: file written for NODE_EXTRA_CA_CERTS }
function useCA(opts) { mitm = opts && opts.ca && opts.bundle ? opts : null; }
function readMark() { try { return JSON.parse(fs.readFileSync(PROXY_MARK, 'utf8')); } catch { return null; } }
const envOf = k => process.env[k] || process.env[k.toLowerCase()] || null;
// What Claude Code used before fiche: { HTTPS_PROXY, NO_PROXY, NODE_EXTRA_CA_CERTS } (null = none).
function before() {
  const env = (() => { try { return read().env || {}; } catch { return {}; } })(), m = readMark();
  const proxy = env.HTTPS_PROXY ?? env.https_proxy;
  if (m && FICHE_URL.test(proxy || '')) return { HTTPS_PROXY: m.upstreamProxy || null, NO_PROXY: env.NO_PROXY ?? env.no_proxy ?? envOf('NO_PROXY'), NODE_EXTRA_CA_CERTS: m.upstreamCA || null };
  const own = v => (v && !FICHE_URL.test(v) ? v : null);
  return { HTTPS_PROXY: own(proxy ?? envOf('HTTPS_PROXY')), NO_PROXY: env.NO_PROXY ?? env.no_proxy ?? envOf('NO_PROXY'), NODE_EXTRA_CA_CERTS: env.NODE_EXTRA_CA_CERTS ?? envOf('NODE_EXTRA_CA_CERTS') };
}
function setProxy(s, url) {
  let m = readMark();
  if (!m) {
    const b = before();
    m = { settings: Object.fromEntries(PROXY_KEYS.map(k => [k, s.env[k] ?? null])), upstreamProxy: b.HTTPS_PROXY, upstreamCA: b.NODE_EXTRA_CA_CERTS && b.NODE_EXTRA_CA_CERTS !== mitm.bundle ? b.NODE_EXTRA_CA_CERTS : null };
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(PROXY_MARK, JSON.stringify(m));
  }
  // Node reads one extra CA file, so the bundle holds the CA Claude Code trusted before (if any) and fiche's.
  let old = '';
  if (m.upstreamCA) try { old = fs.readFileSync(m.upstreamCA, 'utf8').trim() + '\n'; } catch { }
  fs.writeFileSync(mitm.bundle, old + fs.readFileSync(mitm.ca, 'utf8'));
  s.env.HTTPS_PROXY = url;
  if (s.env.https_proxy !== undefined) s.env.https_proxy = url;
  s.env.NODE_EXTRA_CA_CERTS = mitm.bundle;
}
function unsetProxy(s) {
  const m = readMark();
  if (!m) return;
  if (s.env && FICHE_URL.test(s.env.HTTPS_PROXY || s.env.https_proxy || '')) {
    for (const k of PROXY_KEYS) { const v = m.settings?.[k]; if (v == null) delete s.env[k]; else s.env[k] = v; }
  }
  fs.unlinkSync(PROXY_MARK);
}

function read() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return {}; throw new Error('settings.json: ' + e.message); }
}
function write(obj) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  if (fs.existsSync(FILE) && !fs.existsSync(BAK)) fs.copyFileSync(FILE, BAK);
  const tmp = FILE + '.fiche-tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  fs.renameSync(tmp, FILE);
}

function isConnected(url) {
  const env = read().env || {};
  return env.ANTHROPIC_BASE_URL === url && (!mitm || (env.HTTPS_PROXY === url && env.NODE_EXTRA_CA_CERTS === mitm.bundle));
}

// Returns the previous base URL (null if none) so the caller can use it as upstream.
function connect(url) {
  const s = read();
  const prev = s.env?.ANTHROPIC_BASE_URL;
  if (prev === url && !mitm) return { prev: undefined };
  s.env = { ...(s.env || {}), ANTHROPIC_BASE_URL: url };
  if (mitm) setProxy(s, url);
  if (s.env[TETHER] === undefined) {
    s.env[TETHER] = '0';
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(TETHER_MARK, '');
  }
  write(s);
  // An old fiche port is not an upstream; the caller keeps the one it remembered.
  return { prev: prev === url || FICHE_URL.test(prev || '') ? undefined : prev || null };
}

function disconnect(url, prev) {
  const s = read();
  const cur = s.env?.ANTHROPIC_BASE_URL;
  if (cur !== url && !FICHE_URL.test(cur || '')) { if (readMark()) { s.env ||= {}; unsetProxy(s); if (!Object.keys(s.env).length) delete s.env; write(s); } return; }
  if (prev) s.env.ANTHROPIC_BASE_URL = prev;
  else delete s.env.ANTHROPIC_BASE_URL;
  unsetProxy(s);
  if (fs.existsSync(TETHER_MARK)) { if (s.env[TETHER] === '0') delete s.env[TETHER]; fs.unlinkSync(TETHER_MARK); }
  if (!Object.keys(s.env).length) delete s.env;
  write(s);
}

module.exports = { FILE, FICHE_URL, isConnected, connect, disconnect, useCA, before };
