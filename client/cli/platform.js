// Platform facts the CLI needs: WSL2, systemd, the browser opener.
const fs = require('fs'), os = require('os'), { execFile, spawn } = require('child_process');

function wsl() {
  if (process.platform !== 'linux') return null;
  if (process.env.WSL_DISTRO_NAME) return { distro: process.env.WSL_DISTRO_NAME, v2: true };
  try {
    const rel = fs.readFileSync('/proc/sys/kernel/osrelease', 'utf8');
    if (/microsoft/i.test(rel)) return { distro: null, v2: /WSL2/i.test(rel) || !/Microsoft/.test(rel) };
  } catch { }
  return null;
}

// A user systemd instance we can enable a service in. WSL2 only has one when
// systemd=true is set in /etc/wsl.conf, so this is checked, not assumed.
function hasSystemd() {
  if (process.platform !== 'linux') return false;
  try { if (!fs.existsSync('/run/systemd/system')) return false; } catch { return false; }
  return !!(process.env.XDG_RUNTIME_DIR || process.env.DBUS_SESSION_BUS_ADDRESS);
}

// Opens a URL in the user's browser. In WSL2 there may be no Linux browser at all, so Windows'
// own is used through the interop path - which only works if a missing opener really is detected:
// spawn reports ENOENT on the next tick, so each candidate is awaited before the next is tried.
function spawnOk(cmd, args) {
  return new Promise(ok => {
    let child;
    try { child = spawn(cmd, args, { stdio: 'ignore', detached: true }); }
    catch { return ok(false); }
    child.once('error', () => ok(false));
    child.once('spawn', () => { child.unref(); ok(true); });
  });
}

async function openUrl(url) {
  if (!/^https?:\/\//.test(url)) return false;
  const tries = process.platform === 'darwin' ? [['open', [url]]]
    : wsl() ? [['wslview', [url]], ['xdg-open', [url]], ['/mnt/c/Windows/System32/cmd.exe', ['/c', 'start', '', url.replace(/&/g, '^&')]]]
      : [['xdg-open', [url]], ['gio', ['open', url]], ['x-www-browser', [url]]];
  for (const [cmd, args] of tries) if (await spawnOk(cmd, args)) return true;
  return false;
}

const run = (file, args, opts = {}) => new Promise(ok =>
  execFile(file, args, { timeout: 20000, ...opts }, (err, out, errOut) =>
    ok({ ok: !err, out: String(out || '').trim(), err: String(errOut || err?.message || '').trim() })));

module.exports = { wsl, hasSystemd, openUrl, spawnOk, run, isMac: process.platform === 'darwin' };
