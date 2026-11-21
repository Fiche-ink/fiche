// The fiche window app (shell/, built with Tauri) that shows the app screen from cli/ui.js in a
// window of its own, plus desktop notifications. install.sh puts the window app in:
//   macOS  ~/Applications/fiche.app
//   Linux  <prefix>/shell/fiche
//   WSL2   a Windows build under %LOCALAPPDATA%\Programs\fiche-wsl; its /mnt/c path is in
//          <prefix>/shell/windows-exe, and it reaches this daemon through WSL's localhost forwarding.
const fs = require('fs'), path = require('path'), os = require('os');
const P = require('./paths'), plat = require('./platform');

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
function launch(url) {
  const w = find();
  if (!w) return Promise.resolve(false);
  // Not `open -n`: a running copy is brought to the front (and shows its window) instead of a second one.
  if (w.kind === 'mac') return plat.spawnOk('open', ['-a', w.path, '--args', '--url', url]);
  return plat.spawnOk(w.path, ['--url', url]);
}

// Best effort; a machine without a notification service just gets nothing.
function notify(title, body) {
  if (plat.isMac) {
    return plat.spawnOk('osascript', ['-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv)', '-e', 'end run', title, body]);
  }
  if (plat.wsl()) return Promise.resolve(false);
  return plat.spawnOk('notify-send', ['-a', 'fiche', title, body]);
}

module.exports = { find, launch, notify };
