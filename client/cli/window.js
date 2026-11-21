// The fiche window app (shell/, built with Tauri) that shows the app screen from cli/ui.js in a
// window of its own, plus desktop notifications. install.sh puts the window app in:
//   macOS  ~/Applications/fiche.app
//   Linux  <prefix>/shell/fiche
//   WSL2   a Windows build under %LOCALAPPDATA%\Programs\fiche-wsl; its /mnt/c path is in
//          <prefix>/shell/windows-exe, and it reaches this daemon through WSL's localhost forwarding.
const fs = require('fs'), path = require('path'), os = require('os');
const { spawn } = require('child_process');
const P = require('./paths'), plat = require('./platform');

const LOG = path.join(P.dataDir, 'window.log');

// The daemon usually runs as a launchd or systemd service, which may not know the desktop session
// (on Linux, GTK cannot start without DISPLAY or WAYLAND_DISPLAY). `fiche ui` and the hook run in
// the user's session and pass these along; the last ones seen are used for notifications too.
const SESSION_VARS = ['DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'XDG_SESSION_TYPE', 'XDG_CURRENT_DESKTOP', 'GDK_BACKEND'];
let session = {};
function sessionEnv(env) {
  const out = {};
  for (const k of SESSION_VARS) {
    const v = env?.[k];
    if (typeof v === 'string' && v.length < 512 && !/[\0\n]/.test(v)) out[k] = v;
  }
  return out;
}
function setSession(env) { const e = sessionEnv(env); if (Object.keys(e).length) session = e; }
const spawnEnv = () => ({ ...process.env, ...session });

const prefix = () => path.resolve(P.root(), '..');

function find() {
  if (plat.isMac) {
    for (const app of [path.join(os.homedir(), 'Applications', 'fiche.app'), '/Applications/fiche.app']) {
      if (fs.existsSync(path.join(app, 'Contents', 'MacOS'))) return { kind: 'mac', path: app };
    }
    return null;
  }
  if (plat.wsl()) {
    try {
      const exe = fs.readFileSync(path.join(prefix(), 'shell', 'windows-exe'), 'utf8').trim();
      if (exe && fs.existsSync(exe)) return { kind: 'wsl', path: exe };
    } catch { }
    return null;
  }
  const bin = path.join(prefix(), 'shell', 'fiche');
  return fs.existsSync(bin) ? { kind: 'linux', path: bin } : null;
}

// Starts the window app on `url`. A second start hands the address to the window that is
// already running (single instance), which then comes to the front.
function launch(url, env) {
  if (env) setSession(env);
  const w = find();
  if (!w) return Promise.resolve(false);
  // Not `open -n`: a running copy is brought to the front (and shows its window) instead of a second one.
  const [cmd, args] = w.kind === 'mac' ? ['open', ['-a', w.path, '--args', '--url', url]] : [w.path, ['--url', url]];
  // What the window app prints goes to window.log, so a window that dies at start can be explained.
  let out = 'ignore';
  try { fs.mkdirSync(path.dirname(LOG), { recursive: true }); out = fs.openSync(LOG, 'w', 0o600); } catch { }
  return new Promise(ok => {
    let child;
    try { child = spawn(cmd, args, { stdio: ['ignore', out, out], detached: true, env: spawnEnv() }); }
    catch { return ok(false); } finally { if (typeof out === 'number') try { fs.closeSync(out); } catch { } }
    child.once('error', () => ok(false));
    child.once('spawn', () => { child.unref(); ok(true); });
  });
}

// Best effort; a machine without a notification service just gets nothing.
function notify(title, body) {
  if (plat.isMac) {
    return plat.spawnOk('osascript', ['-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv)', '-e', 'end run', title, body]);
  }
  if (plat.wsl()) return Promise.resolve(false);
  return new Promise(ok => {
    let child;
    try { child = spawn('notify-send', ['-a', 'fiche', title, body], { stdio: 'ignore', detached: true, env: spawnEnv() }); } catch { return ok(false); }
    child.once('error', () => ok(false));
    child.once('spawn', () => { child.unref(); ok(true); });
  });
}

module.exports = { find, launch, notify, sessionEnv };
