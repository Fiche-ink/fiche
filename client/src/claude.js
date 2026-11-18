// Connects Claude Code to the local proxy by setting env.ANTHROPIC_BASE_URL in ~/.claude/settings.json.
// The first change keeps a copy as settings.json.fiche-bak. An existing ANTHROPIC_BASE_URL (another
// router) is remembered, used as the proxy's upstream, and put back on disconnect.
const fs = require('fs'), path = require('path'), os = require('os');

const FILE = path.join(os.homedir(), '.claude', 'settings.json');
const BAK = FILE + '.fiche-bak';
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
  if (s.env[TETHER] === undefined) { s.env[TETHER] = '0'; fs.writeFileSync(TETHER_MARK, ''); }
  write(s);
  return { prev: prev || null };
}

function disconnect(url, prev) {
  const s = read();
  if (s.env?.ANTHROPIC_BASE_URL !== url) return;
  if (prev) s.env.ANTHROPIC_BASE_URL = prev;
  else delete s.env.ANTHROPIC_BASE_URL;
  if (fs.existsSync(TETHER_MARK)) { if (s.env[TETHER] === '0') delete s.env[TETHER]; fs.unlinkSync(TETHER_MARK); }
  if (!Object.keys(s.env).length) delete s.env;
  write(s);
}

module.exports = { FILE, isConnected, connect, disconnect };
