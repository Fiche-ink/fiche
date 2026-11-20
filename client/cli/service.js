// "Start at login" for the CLI daemon, in whatever the platform actually has:
//   macOS            a LaunchAgent (~/Library/LaunchAgents/ink.fiche.cli.plist)
//   Linux + systemd  a user unit (~/.config/systemd/user/fiche.service)
//   neither          a guarded line in the login shell's rc file (WSL2 without systemd=true)
// The fallback matters: WSL2 only runs systemd when /etc/wsl.conf says so, and a plain
// `wsl` session has no init to hook into.
const fs = require('fs'), path = require('path'), os = require('os');
const P = require('./paths'), plat = require('./platform');

const LABEL = 'ink.fiche.cli';
const plist = () => path.join(P.home, 'Library', 'LaunchAgents', LABEL + '.plist');
const unit = () => path.join(process.env.XDG_CONFIG_HOME && path.isAbsolute(process.env.XDG_CONFIG_HOME)
  ? process.env.XDG_CONFIG_HOME : path.join(P.home, '.config'), 'systemd', 'user', 'fiche.service');
const MARK = '# fiche (start the context compressor for Claude Code)';

// Which of the three is usable here. systemd can be running and still have no user instance to
// talk to - a headless box entered over ssh without lingering, a WSL2 distro with systemd=true
// but no session bus - and `systemctl --user` then fails. Asking it is the only honest test, so
// this is async; the answer is cached for the process.
let cached = null;
async function kind() {
  if (cached) return cached;
  if (plat.isMac) return (cached = 'launchd');
  if (plat.hasSystemd() && (await plat.run('systemctl', ['--user', 'show-environment'])).ok) return (cached = 'systemd');
  return (cached = 'profile');
}

const xml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function plistBody() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(P.launcher())}</string>
    <string>daemon</string>
  </array>
  <key>RunAtLoad</key><true/>
  <!-- Restart a crash, but let a clean exit stay stopped, so "fiche stop" really stops it.
       Plain KeepAlive would bring the daemon back a second later. The systemd unit below says
       the same thing with Restart=on-failure. -->
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${xml(P.logFile)}</string>
  <key>StandardErrorPath</key><string>${xml(P.logFile)}</string>
</dict>
</plist>
`;
}

function unitBody() {
  return `[Unit]
Description=fiche - optical context compression for Claude Code
After=default.target

[Service]
Type=simple
ExecStart=${P.launcher()} daemon
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
}

// The rc file a login shell actually reads, so the fallback runs once per session.
function rcFile() {
  const shell = path.basename(process.env.SHELL || 'bash');
  if (shell === 'zsh') return path.join(P.home, '.zshrc');
  if (shell === 'fish') return path.join(P.home, '.config', 'fish', 'config.fish');
  return fs.existsSync(path.join(P.home, '.bashrc')) ? path.join(P.home, '.bashrc') : path.join(P.home, '.profile');
}
function rcLine() {
  const fish = rcFile().endsWith('.fish');
  const cmd = `${P.launcher()} start --quiet`;
  return fish ? `${MARK}\ntest -x ${P.launcher()}; and ${cmd} >/dev/null 2>&1\n`
    : `${MARK}\n[ -x ${P.launcher()} ] && ${cmd} >/dev/null 2>&1\n`;
}

async function install() {
  const k = await kind();
  if (k === 'launchd') {
    fs.mkdirSync(path.dirname(plist()), { recursive: true });
    fs.writeFileSync(plist(), plistBody());
    await plat.run('launchctl', ['bootout', `gui/${process.getuid()}/${LABEL}`]); // ignore "not loaded"
    const r = await plat.run('launchctl', ['bootstrap', `gui/${process.getuid()}`, plist()]);
    if (!r.ok) { // older macOS
      const l = await plat.run('launchctl', ['load', '-w', plist()]);
      if (!l.ok) return { kind: k, on: false, error: l.err || r.err };
    }
    return { kind: k, on: true, file: plist() };
  }
  if (k === 'systemd') {
    fs.mkdirSync(path.dirname(unit()), { recursive: true });
    fs.writeFileSync(unit(), unitBody());
    await plat.run('systemctl', ['--user', 'daemon-reload']);
    const r = await plat.run('systemctl', ['--user', 'enable', '--now', 'fiche.service']);
    // Headless machines need lingering, or the unit stops when the last session ends.
    await plat.run('loginctl', ['enable-linger', os.userInfo().username]);
    return { kind: k, on: r.ok, file: unit(), error: r.ok ? null : r.err };
  }
  const rc = rcFile();
  let body = '';
  try { body = fs.readFileSync(rc, 'utf8'); } catch { }
  if (!body.includes(MARK)) {
    fs.mkdirSync(path.dirname(rc), { recursive: true });
    fs.appendFileSync(rc, (body && !body.endsWith('\n') ? '\n' : '') + '\n' + rcLine());
  }
  return { kind: k, on: true, file: rc };
}

async function uninstall() {
  const k = await kind();
  if (k === 'launchd') {
    await plat.run('launchctl', ['bootout', `gui/${process.getuid()}/${LABEL}`]);
    await plat.run('launchctl', ['unload', '-w', plist()]);
    fs.rmSync(plist(), { force: true });
    return { kind: k, on: false };
  }
  if (k === 'systemd') {
    await plat.run('systemctl', ['--user', 'disable', '--now', 'fiche.service']);
    fs.rmSync(unit(), { force: true });
    await plat.run('systemctl', ['--user', 'daemon-reload']);
    return { kind: k, on: false };
  }
  const rc = rcFile();
  try {
    const lines = fs.readFileSync(rc, 'utf8').split('\n');
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim() === MARK.trim()) { i++; continue; } // the marker and the line under it
      out.push(lines[i]);
    }
    fs.writeFileSync(rc, out.join('\n'));
  } catch { }
  return { kind: k, on: false, file: rc };
}

async function state() {
  const k = await kind();
  if (k === 'launchd') {
    if (!fs.existsSync(plist())) return { kind: k, on: false };
    const r = await plat.run('launchctl', ['print', `gui/${process.getuid()}/${LABEL}`]);
    return { kind: k, on: r.ok, file: plist() };
  }
  if (k === 'systemd') {
    const r = await plat.run('systemctl', ['--user', 'is-enabled', 'fiche.service']);
    return { kind: k, on: r.out === 'enabled', file: unit() };
  }
  let body = '';
  try { body = fs.readFileSync(rcFile(), 'utf8'); } catch { }
  return { kind: k, on: body.includes(MARK), file: rcFile() };
}

module.exports = { kind, install, uninstall, state, LABEL };
