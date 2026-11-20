// Where the CLI keeps its files, per platform.
//
// The GUI app uses Electron's userData folder; the CLI picks the platform's own place:
//   macOS  ~/Library/Application Support/fiche
//   Linux  $XDG_CONFIG_HOME/fiche (default ~/.config/fiche)
// Engine work files stay in ~/.cache/fiche-cc on every platform, same as the PC build,
// so a machine that runs both sees one cache.
const os = require('os'), path = require('path'), fs = require('fs');

const home = os.homedir();
const isMac = process.platform === 'darwin';

// Install root: <root>/cli/paths.js -> <root>. FICHE_HOME is set by bin/fiche and keeps the
// `current` symlink in the path, so a service unit written from here survives an upgrade.
const root = () => process.env.FICHE_HOME || path.resolve(__dirname, '..');
const launcher = () => process.env.FICHE_LAUNCHER || path.join(root(), 'bin', 'fiche');

// The open client (proxy, engine, Claude Code connection) ships as <root>/client; in the repo it
// is desktop/app/src. Everything the daemon does with Claude data lives there.
function clientDir() {
  const a = path.join(root(), 'client');
  return fs.existsSync(path.join(a, 'proxy.js')) ? a : path.join(root(), 'app', 'src');
}

// The version next to the client: <root>/package.json installed, desktop/app/package.json in the repo.
function version() {
  try { return JSON.parse(fs.readFileSync(path.join(clientDir(), '..', 'package.json'), 'utf8')).version || '0.0.0'; }
  catch { return '0.0.0'; }
}



const dataDir = isMac
  ? path.join(home, 'Library', 'Application Support', 'fiche')
  : path.join(process.env.XDG_CONFIG_HOME && path.isAbsolute(process.env.XDG_CONFIG_HOME)
      ? process.env.XDG_CONFIG_HOME : path.join(home, '.config'), 'fiche');

const runDir = path.join(dataDir, 'run');
const sock = path.join(runDir, 'control.sock');
const pidFile = path.join(runDir, 'fiche.pid');
const logFile = path.join(dataDir, 'daemon.log');

function ensure() { fs.mkdirSync(runDir, { recursive: true }); return dataDir; }

module.exports = { home, isMac, root, launcher, version, clientDir, dataDir, runDir, sock, pidFile, logFile, ensure };
