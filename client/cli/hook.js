// "Open with Claude Code": a SessionStart hook in ~/.claude/settings.json that runs
// `fiche ui --session` when a Claude Code session starts or resumes, so the fiche window comes
// up next to it (only when no fiche window is open yet; see daemon.js ui:session).
//
// SessionStart hook output is added to Claude's context, so the command prints nothing.
const fs = require('fs'), path = require('path'), os = require('os');
const P = require('./paths');

const FILE = path.join(os.homedir(), '.claude', 'settings.json');
const TAG = 'ui --session';
const q = s => `'${String(s).replace(/'/g, `'\\''`)}'`;
const command = () => `${q(P.launcher())} ${TAG} >/dev/null 2>&1 || true`;
const ours = h => typeof h?.command === 'string' && h.command.includes(TAG) && /fiche/.test(h.command);

function read() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return {}; throw new Error('settings.json: ' + e.message); }
}
function write(obj) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = FILE + '.fiche-tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  fs.renameSync(tmp, FILE);
}

// Drops our entry (and any group it leaves empty); returns true if something changed.
function strip(s) {
  const groups = s.hooks?.SessionStart;
  if (!Array.isArray(groups)) return false;
  let changed = false;
  const kept = [];
  for (const g of groups) {
    const hs = Array.isArray(g?.hooks) ? g.hooks.filter(h => !ours(h)) : g?.hooks;
    if (Array.isArray(g?.hooks) && hs.length !== g.hooks.length) changed = true;
    if (Array.isArray(hs) && hs.length === 0) continue;
    kept.push(hs === g?.hooks ? g : { ...g, hooks: hs });
  }
  if (!changed) return false;
  if (kept.length) s.hooks.SessionStart = kept; else delete s.hooks.SessionStart;
  if (!Object.keys(s.hooks).length) delete s.hooks;
  return true;
}

function installed() {
  try { return (read().hooks?.SessionStart || []).some(g => (g?.hooks || []).some(ours)); } catch { return false; }
}

function add() {
  const s = read();
  strip(s);
  s.hooks = s.hooks && typeof s.hooks === 'object' ? s.hooks : {};
  s.hooks.SessionStart = Array.isArray(s.hooks.SessionStart) ? s.hooks.SessionStart : [];
  s.hooks.SessionStart.push({ matcher: 'startup|resume', hooks: [{ type: 'command', command: command(), timeout: 10 }] });
  write(s);
}

function remove() {
  let s;
  try { s = read(); } catch { return; }
  if (strip(s)) write(s);
}

module.exports = { add, remove, installed, FILE };
