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

function isConnected(url) { return read().env?.ANTHROPIC_BASE_URL === url; }

// Returns the previous base URL (null if none) so the caller can use it as upstream.
function connect(url) {
  const s = read();
  const prev = s.env?.ANTHROPIC_BASE_URL;
  if (prev === url) return { prev: undefined };
  s.env = { ...(s.env || {}), ANTHROPIC_BASE_URL: url };
  if (s.env[TETHER] === undefined) {
    s.env[TETHER] = '0';
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(TETHER_MARK, '');
  }
  write(s);
  // An old fiche port is not an upstream; the caller keeps the one it remembered.
  return { prev: FICHE_URL.test(prev || '') ? undefined : prev || null };
}

function disconnect(url, prev) {
  const s = read();
  const cur = s.env?.ANTHROPIC_BASE_URL;
  if (cur !== url && !FICHE_URL.test(cur || '')) return;
  if (prev) s.env.ANTHROPIC_BASE_URL = prev;
  else delete s.env.ANTHROPIC_BASE_URL;
  if (fs.existsSync(TETHER_MARK)) { if (s.env[TETHER] === '0') delete s.env[TETHER]; fs.unlinkSync(TETHER_MARK); }
  if (!Object.keys(s.env).length) delete s.env;
  write(s);
}

module.exports = { FILE, isConnected, connect, disconnect };
