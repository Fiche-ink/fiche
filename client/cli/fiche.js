#!/usr/bin/env node
// fiche command line client (macOS, Linux, WSL2).
//
// `fiche start` puts the daemon (cli/daemon.js) in the background; every other command talks to it
// over a unix socket. There is no window and no tray: status, savings and the sent-log are printed.
const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto');
const { spawn } = require('child_process');
const P = require('./paths'), control = require('./control'), plat = require('./platform'), service = require('./service');

const ko = /^ko/i.test(process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || '');
const T = (k, e) => (ko ? k : e);
const argv = process.argv.slice(2);
const flag = n => argv.includes('--' + n);
const num = (n, d) => { const i = argv.indexOf('-' + n); return i >= 0 && argv[i + 1] ? parseInt(argv[i + 1], 10) || d : d; };

const die = (msg, code = 1) => { console.error(msg); process.exit(code); };
// Hangul and other East Asian characters take two columns in a terminal, which String.padEnd
// cannot know, so widths are measured here instead.
const WIDE = /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/;
const width = t => [...String(t)].reduce((a, c) => a + (WIDE.test(c) ? 2 : 1), 0);
const pad = (t, n) => String(t) + ' '.repeat(Math.max(1, n - width(t)));
const yes = b => (b ? T('켜짐', 'on') : T('꺼짐', 'off'));
const n = x => (x || 0).toLocaleString(ko ? 'ko-KR' : 'en-US');
// Film is counted in frames; 100 frames = 1 roll. Worded as the app's home screen words it.
function frames(fr) {
  fr = Math.max(0, Math.floor(fr || 0));
  const r = Math.floor(fr / 100), c = fr % 100;
  if (ko) return r ? `${n(r)}롤${c ? ` ${c}컷` : ''}` : `${c}컷`;
  return r ? `${n(r)} roll${r > 1 ? 's' : ''}${c ? ` ${c} frames` : ''}` : `${c} frame${c === 1 ? '' : 's'}`;
}

async function ask(action, args, timeout) {
  try { return await control.send(action, args, timeout); }
  catch (e) {
    if (e.code === 'ENOTRUNNING') die(T('fiche가 실행되지 않았습니다. `fiche start`로 시작합니다.',
      'fiche is not running. Start it with `fiche start`.'), 4);
    throw e;
  }
}

// ---- start / stop ----
async function start({ quiet = false } = {}) {
  if (await control.alive()) { if (!quiet) console.log(T('이미 실행 중입니다.', 'Already running.')); return; }
  P.ensure();
  const out = fs.openSync(P.logFile, 'a');
  const child = spawn(process.execPath, [__filename, 'daemon'], {
    detached: true, stdio: ['ignore', out, out],
    env: { ...process.env, FICHE_HOME: P.root(), FICHE_LAUNCHER: P.launcher() },
  });
  child.unref();
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 250));
    if (await control.alive()) {
      if (!quiet) {
        const s = await ask('status');
        console.log(T(`fiche를 시작했습니다. 버전 ${s.version} · 프록시 127.0.0.1:${s.port}`, `fiche ${s.version} started. Proxy on 127.0.0.1:${s.port}`));
        if (!s.account.signedIn) console.log(T('로그인해야 압축이 시작됩니다: fiche login', 'Sign in to start compressing: fiche login'));
      }
      return;
    }
  }
  die(T(`시작하지 못했습니다. 로그를 봅니다: ${P.logFile}`, `Could not start. See the log: ${P.logFile}`), 5);
}

async function stop({ quiet = false } = {}) {
  if (!(await control.alive())) { if (!quiet) console.log(T('실행 중이 아닙니다.', 'Not running.')); return; }
  try { await control.send('quit', {}, 5000); } catch { }
  for (let i = 0; i < 40; i++) {
    if (!(await control.alive())) { if (!quiet) console.log(T('종료했습니다.', 'Stopped.')); return; }
    await new Promise(r => setTimeout(r, 250));
  }
  // Last resort: the pid file.
  try { process.kill(parseInt(fs.readFileSync(P.pidFile, 'utf8'), 10), 'SIGTERM'); } catch { }
  if (!quiet) console.log(T('종료 신호를 보냈습니다.', 'Sent a stop signal.'));
}

// ---- status ----
async function status() {
  if (flag('json')) {
    if (!(await control.alive())) return console.log(JSON.stringify({ running: false }, null, 2));
    return console.log(JSON.stringify({ running: true, ...(await ask('status')), service: await service.state() }, null, 2));
  }
  if (!(await control.alive())) {
    console.log(T('fiche: 실행 중이 아닙니다', 'fiche: not running'));
    console.log(T('  시작: fiche start', '  start it: fiche start'));
    return;
  }
  const s = await ask('status'), sv = await service.state();
  const a = s.account;
  const rows = [
    [T('버전', 'version'), `${s.version} (cli, ${s.platform}-${s.arch}${s.wsl ? ', WSL2' : ''})`],
    [T('프록시', 'proxy'), s.proxyListening ? `127.0.0.1:${s.port} · ${T('압축', 'compression')} ${yes(s.proxyOn)}` : T('실패: ', 'failed: ') + s.proxyError],
    [T('Claude Code', 'Claude Code'), s.connected ? T('연결됨', 'connected') + ` · ${s.settingsFile}` : (s.claudeFound ? T('설치됨, 연결 안 됨', 'installed, not connected') : T('찾지 못했습니다', 'not found'))],
    [T('계정', 'account'), a.signedIn ? (a.email || a.accountId || T('로그인됨', 'signed in')) : T('로그아웃 상태 · fiche login', 'signed out · fiche login')],
    [T('데이터 기여', 'data contribution'), yes(s.contrib)],
    [T('로그인 시 시작', 'start at login'), `${yes(sv.on)} (${sv.kind})`],
    [T('요청', 'requests'), `${n(s.stats.requests)} · ${T('압축', 'compressed')} ${n(s.stats.compressed)} · ${T('통과', 'passthrough')} ${n(s.stats.passthrough)}${s.stats.errors ? ` · ${T('오류', 'errors')} ${n(s.stats.errors)}` : ''}`],
  ];
  // /v1/me answers { film: <ledger summary> }, and the ledger's own balance sits one level in,
  // counted in frames (100 frames = 1 roll). Same shape the app's home screen reads.
  const film = a.me?.film?.film;
  if (film) {
    const extra = [];
    if (a.me.film.today?.capFrames) extra.push(T(`오늘 ${frames(a.me.film.today.frames)} / ${frames(a.me.film.today.capFrames)}`,
      `today ${frames(a.me.film.today.frames)} of ${frames(a.me.film.today.capFrames)}`));
    if (s.contrib === false && film.freeFrames) extra.push(T('데이터 기여를 꺼서 무료 필름은 쓰지 않습니다', 'free film unused while data contribution is off'));
    rows.push([T('필름', 'film'), `${frames(film.usableFrames)} ${T('남음', 'left')}${extra.length ? ' · ' + extra.join(' · ') : ''}`]);
  }
  if (s.engine.lastError) rows.push([T('엔진', 'engine'), s.engine.lastError]);
  const w = Math.max(...rows.map(r => width(r[0])));
  for (const [k, v] of rows) console.log('  ' + pad(k, w + 2) + v);
  const t = (await ask('stats')).today;
  const cut = Math.max(0, (t?.before || 0) - (t?.after || 0)), cutPct = t?.before ? Math.round(cut / t.before * 100) : 0;
  if (t?.before) console.log('  ' + pad(T('오늘', 'today'), w + 2) + T(`${n(cut)} 토큰 절약 (-${cutPct}%, 추정)`, `${n(cut)} tokens saved (-${cutPct}%, estimate)`));
}

async function login() {
  if (!(await control.alive())) await start({ quiet: true });
  const r = await ask('login', {}, 15000);
  if (r.signedIn) return console.log(T('이미 로그인되어 있습니다.', 'Already signed in.'));
  if (!r.url) die(T('로그인을 시작하지 못했습니다: ', 'Could not start sign-in: ') + (r.error || 'unknown'), 6);
  console.log(T('브라우저에서 로그인합니다:', 'Sign in from the browser:'));
  console.log('  ' + r.url);
  if (await plat.openUrl(r.url)) console.log(T('브라우저를 열었습니다.', 'Opened your browser.'));
  else console.log(T('브라우저가 열리지 않으면 위 주소를 직접 엽니다.', 'If no browser opened, open the address above yourself.'));
  for (let i = 0; i < 240; i++) {
    await new Promise(r2 => setTimeout(r2, 2500));
    const s = await ask('status');
    if (s.account.signedIn) return console.log(T(`로그인했습니다: ${s.account.email || s.account.accountId}`, `Signed in as ${s.account.email || s.account.accountId}`));
  }
  die(T('시간이 초과되었습니다.', 'Timed out.'), 7);
}

async function stats() {
  const s = await ask('stats');
  if (flag('json')) return console.log(JSON.stringify(s, null, 2));
  const line = (label, d) => console.log('  ' + pad(label, 12) + (d.before
    ? `${n(d.before)} → ${n(d.after)} ${T('토큰', 'tokens')} (-${Math.max(0, Math.round((1 - d.after / d.before) * 100))}%) · ${n(d.requests)} ${T('요청', 'requests')}`
    : T('기록 없음', 'nothing yet')));
  console.log(T('입력 토큰 추정치입니다.', 'Input-token estimates.'));
  line(T('오늘', 'today'), s.today);
  line(s.month.name, s.month);
  console.log('  ' + pad(T('누적', 'all time'), 12) + `${n(s.total.requests)} ${T('요청', 'requests')} · ${n(s.total.pages)} ${T('장', 'pages')} · ${(s.total.px / 5e9).toFixed(2)} ${T('롤', 'rolls')}`);
  const recent = s.sessions.slice(0, 8);
  if (recent.length) {
    console.log('\n  ' + T('최근 세션', 'recent sessions'));
    for (const x of recent) console.log('    ' + pad(String(x.label || x.id.slice(0, 8)).slice(0, 22), 24) + `${n(x.before)} → ${n(x.after)}`);
  }
}

// ---- app screen ----
async function screen() {
  // From the SessionStart hook: never print (it would land in Claude's context), never fail.
  if (flag('session')) {
    try { if (await control.alive()) await control.send('ui:open', { session: true, env: require('./window').sessionEnv(process.env) }, 5000); } catch { }
    process.exit(0);
  }
  if (argv[1] === 'with-claude') {
    const on = argv[2] === 'on';
    if (!['on', 'off'].includes(argv[2])) die('fiche ui with-claude on|off');
    const r = await ask('ui:with-claude', { on });
    return console.log(on
      ? T(`Claude Code를 시작하면 fiche 창도 같이 엽니다${r.hook ? '' : ' (창 앱이 설치되고 Claude Code가 연결되면 적용)'}.`, `fiche opens along with Claude Code${r.hook ? '' : ' (once the window app is installed and Claude Code is connected)'}.`)
      : T('Claude Code와 같이 열지 않습니다.', 'fiche no longer opens with Claude Code.'));
  }
  if (!(await control.alive())) await start({ quiet: true });
  if (flag('url')) return console.log((await ask('ui')).url);
  const r = await ask('ui:open', { env: require('./window').sessionEnv(process.env) });
  if (r.error) die(r.error);
  if (r.opened === 'window') return console.log(T('fiche 창을 열었습니다.', 'Opened the fiche window.'));
  if (r.opened === 'browser') return console.log(T('브라우저에서 열었습니다.', 'Opened it in your browser.'));
  console.log(T('브라우저에서 이 주소를 여세요:', 'Open this address in a browser:'));
  console.log(r.url);
}

async function netlog() {
  if (flag('daemon')) {
    const body = fs.existsSync(P.logFile) ? fs.readFileSync(P.logFile, 'utf8').split('\n') : [];
    return console.log(body.slice(-num('n', 40)).join('\n'));
  }
  const list = await ask('netlog', { limit: num('n', 30) });
  if (flag('json')) return console.log(JSON.stringify(list, null, 2));
  for (const e of list) {
    const t = new Date(e.at).toTimeString().slice(0, 8);
    const size = e.bytesOriginal ? `${n(e.bytes)}B (${T('원래', 'was')} ${n(e.bytesOriginal)}B)` : `${n(e.bytes)}B`;
    console.log(`  ${t}  ${String(e.kind).padEnd(9)} ${String(e.status).padEnd(4)} ${String(e.host + e.path).padEnd(38).slice(0, 38)} ${size}`);
  }
}

// `fiche doctor` prints in the user's language, so a caller must not grep its lines: the two
// checks that decide whether this install can work at all set the exit code instead.
async function doctor() {
  let hard = true;
  const ok = (b, s) => console.log(`  ${b ? '✓' : '✗'} ${s}`);
  const need = (b, s) => { if (!b) hard = false; ok(b, s); };
  console.log(T('fiche 점검', 'fiche check'));
  const major = parseInt(process.versions.node.split('.')[0], 10);
  need(major >= 20, `node ${process.versions.node}${major >= 20 ? '' : T(' (20 이상이 필요합니다)', ' (20 or newer required)')}`);
  ok(true, `${process.platform}-${process.arch}${plat.wsl() ? ' · WSL2' + (plat.wsl().distro ? ` (${plat.wsl().distro})` : '') : ''}`);
  // The engine loads, and the renderer really draws. Loading the engine alone proves little:
  // the native canvas module and the fonts are pulled in lazily at the first page, so a tarball
  // built for another platform would pass that and fail on the first compressed request.
  let engineOk = false, engineErr = '', pageOk = false, pageErr = '';
  try {
    const engine = require(path.join(P.clientDir(), 'engine.js'));
    engine.setup({}, null);
    const E = await engine.load();
    engineOk = true;
    // Fresh text every run: the engine keeps a drawn page by content hash, and a cached hit
    // would never touch the native module - which is the thing being checked.
    const probe = `fiche check ${crypto.randomBytes(6).toString('hex')} 점검 0123456789\nconst x = 1;`;
    const pages = await E._render(probe, 'code');
    if (!pages?.length || !pages[0]?.b64 || !pages[0].w) throw new Error('the renderer returned no page');
    pageOk = true;
  } catch (e) {
    const m = String(e?.message || e).split('\n')[0];
    if (engineOk) pageErr = m; else engineErr = m;
  }
  need(engineOk, T('엔진 로드', 'engine loads') + (engineOk ? '' : ': ' + engineErr));
  need(pageOk, T('렌더러로 한 장 그리기', 'renderer draws a page') + (pageOk ? '' : ': ' + pageErr));
  const claude = require(path.join(P.clientDir(), 'claude.js'));
  ok(fs.existsSync(path.dirname(claude.FILE)), `${claude.FILE}`);
  const running = await control.alive();
  ok(running, running ? T('데몬 실행 중', 'daemon running') : T('데몬이 실행 중이 아닙니다 (fiche start)', 'daemon not running (fiche start)'));
  const sv = await service.state();
  ok(sv.on, T('로그인 시 시작', 'start at login') + `: ${sv.kind}${sv.on ? '' : T(' (fiche service install)', ' (fiche service install)')}`);
  const w = plat.wsl();
  if (w) {
    console.log(T('\n  WSL2에서는 이 리눅스 쪽 설치가 WSL 안의 Claude Code를 맡습니다. 윈도 쪽 Claude Code는 윈도용 fiche 앱이 따로 맡고, 둘은 서로 간섭하지 않습니다.',
      '\n  In WSL2 this Linux install handles Claude Code inside WSL. Claude Code on the Windows side is handled by the Windows app; the two do not get in each other\'s way.'));
    // WSL1 shares the Windows network namespace, so both copies would want port 47321.
    if (!w.v2) console.log(T(`  이 배포판은 WSL1로 보입니다. WSL1은 윈도와 포트를 공유하므로 윈도 앱과 이 설치 중 하나만 씁니다.`,
      '  This distro looks like WSL1, which shares ports with Windows: run either the Windows app or this install, not both.'));
  }
  if (!hard) {
    console.error(T('\n  이 상태로는 fiche가 동작하지 않습니다.', '\n  fiche cannot work in this state.'));
    process.exitCode = 1;
  }
}

async function uninstall() {
  await service.uninstall();
  await stop({ quiet: true });
  // The daemon restores these when it stops; if it was not running, or died, do it here.
  try {
    let cfg = {};
    try { cfg = JSON.parse(fs.readFileSync(path.join(P.dataDir, 'config.json'), 'utf8')) || {}; } catch { }
    const { PORT } = require(path.join(P.clientDir(), 'proxy.js'));
    require(path.join(P.clientDir(), 'claude.js')).disconnect(`http://127.0.0.1:${PORT}`, cfg.upstream);
  } catch (e) { console.error(T(`Claude Code 설정을 되돌리지 못했습니다: ${e.message}`, `Could not restore the Claude Code settings: ${e.message}`)); }
  try { require('./hook').remove(); } catch { }
  // install.sh lays the install out as <prefix>/versions/<ver> with a shared <prefix>/node, so
  // the folder worth naming is the prefix, not the version that happens to be running.
  const real = fs.realpathSync(P.root());
  const m = /^(.*)\/versions\/[^/]+$/.exec(real);
  const prefix = m ? m[1] : real;
  console.log(T('자동 시작을 해제하고 데몬을 종료했습니다. Claude Code 설정도 되돌렸습니다.',
    'Removed the login item, stopped the daemon and put Claude Code settings back.'));
  console.log(T('남은 파일을 지웁니다:', 'Delete the remaining files with:'));
  const bins = [path.join(P.home, '.local', 'bin', 'fiche'), P.launcher()].filter(f => { try { return fs.lstatSync(f).isSymbolicLink(); } catch { return false; } });
  // The window app lives outside the prefix: ~/Applications on macOS, the app menu entry on Linux,
  // and on WSL2 a Windows folder plus a Start menu shortcut that install.sh listed.
  const extra = [path.join(P.home, 'Applications', 'fiche.app'), path.join(P.home, '.local', 'share', 'applications', 'fiche.desktop'), path.join(P.home, '.local', 'share', 'icons', 'hicolor', '256x256', 'apps', 'fiche.png')];
  try { extra.push(...fs.readFileSync(path.join(prefix, 'shell', 'windows-files'), 'utf8').split('\n').map(s => s.trim()).filter(Boolean)); } catch { }
  const q = s => `'${s.replace(/'/g, `'\\''`)}'`;
  const all = [prefix, P.dataDir, path.join(P.home, '.cache', 'fiche-cc'), ...extra.filter(f => fs.existsSync(f)), ...bins];
  console.log(`  rm -rf ${all.map(q).join(' ')}`);
}

const HELP = () => T(`fiche ${P.version()} · Claude Code 문맥 압축

  fiche                    상태를 봅니다
  fiche ui                     앱 화면 열기 (with-claude on|off: Claude Code와 같이 열기)
  fiche start | stop | restart
  fiche login | logout
  fiche connect | disconnect   Claude Code의 settings.json 연결
  fiche on | off               압축 켜고 끄기
  fiche stats                  절약량
  fiche log [-n 30]            보낸 기록 (--daemon 이면 데몬 로그)
  fiche contrib on|off         데이터 기여
  fiche plan pro|max5|max10    쓰는 요금제
  fiche service install|uninstall|status
  fiche doctor                 점검
  fiche uninstall
`, `fiche ${P.version()} · context compression for Claude Code

  fiche                    show status
  fiche ui                     open the app screen (with-claude on|off: open with Claude Code)
  fiche start | stop | restart
  fiche login | logout
  fiche connect | disconnect   point Claude Code's settings.json at fiche
  fiche on | off               turn compression on or off
  fiche stats                  what it saved
  fiche log [-n 30]            sent log (--daemon for the daemon log)
  fiche contrib on|off         data contribution
  fiche plan pro|max5|max10    which plan you are on
  fiche service install|uninstall|status
  fiche doctor                 check the install
  fiche uninstall
`);

async function main() {
  const cmd = (argv[0] || 'status').replace(/^--/, '');
  switch (cmd) {
    case 'daemon': return require('./daemon').main();
    case 'start': return start({ quiet: flag('quiet') });
    case 'stop': return stop({});
    case 'restart': await stop({ quiet: true }); return start({});
    case 'status': case 'st': return status();
    case 'login': return login();
    case 'ui': return screen();
    case 'logout': await ask('logout'); return console.log(T('로그아웃했습니다.', 'Signed out.'));
    case 'connect': { const r = await ask('connect'); if (r?.error) die(T(`연결하지 않았습니다: ${r.error}`, `Not connected: ${r.error}`)); }
      return console.log(T('Claude Code를 연결했습니다. 열려 있는 창은 다시 시작해야 적용됩니다.', 'Connected. Claude Code windows that are already open pick it up after a restart.'));
    case 'disconnect': await ask('disconnect'); return console.log(T('연결을 끊고 설정을 되돌렸습니다.', 'Disconnected and put the settings back.'));
    case 'on': await ask('proxy', { on: true }); return console.log(T('압축을 켰습니다.', 'Compression on.'));
    case 'off': await ask('proxy', { on: false }); return console.log(T('압축을 껐습니다. 요청은 그대로 지나갑니다.', 'Compression off. Requests pass through untouched.'));
    case 'contrib': {
      const on = argv[1] === 'on';
      if (!['on', 'off'].includes(argv[1])) die('fiche contrib on|off');
      if ((await ask('contrib', { on })).profileError) die(T('서버에 저장하지 못해 바꾸지 않았습니다. 잠시 뒤 다시 시도하세요.', 'Could not save to the server, so nothing changed. Try again shortly.'));
      return console.log(T(`데이터 기여를 ${on ? '켰습니다' : '껐습니다'}.`, `Data contribution ${on ? 'on' : 'off'}.`));
    }
    case 'plan': {
      if (!['pro', 'max5', 'max10'].includes(argv[1])) die('fiche plan pro|max5|max10');
      if ((await ask('plan', { plan: argv[1] })).profileError) die(T('서버에 저장하지 못해 바꾸지 않았습니다. 잠시 뒤 다시 시도하세요.', 'Could not save to the server, so nothing changed. Try again shortly.'));
      return console.log(T(`요금제를 ${argv[1]}로 저장했습니다.`, `Plan set to ${argv[1]}.`));
    }
    case 'stats': return stats();
    case 'log': return netlog();
    case 'service': {
      const sub = argv[1] || 'status';
      if (sub === 'install') {
        // launchd and systemd start the daemon themselves. A copy started by hand already holds
        // the socket and the port, so it is handed over rather than left to collide.
        const was = await control.alive();
        if (was && (await service.kind()) !== 'profile') await stop({ quiet: true });
        const r = await service.install();
        // launchd and systemd start it themselves, but take a moment. Starting one here before
        // they are up means two daemons race for the socket and the service's copy is the one
        // that gives up - leaving 'start at login' enabled but owning nothing.
        for (let i = 0; i < 40 && !(await control.alive()); i++) await new Promise(r2 => setTimeout(r2, 250));
        if (!(await control.alive())) await start({ quiet: true });
        return console.log(r.on ? T(`로그인 시 시작을 켰습니다 (${r.kind}): ${r.file}`, `Start at login is on (${r.kind}): ${r.file}`) : T('실패: ', 'failed: ') + r.error);
      }
      if (sub === 'uninstall') {
        // Only the login item goes away; fiche keeps running for this session.
        const was = await control.alive();
        const r = await service.uninstall();
        if (was && !(await control.alive())) await start({ quiet: true });
        return console.log(T(`로그인 시 시작을 껐습니다 (${r.kind}).`, `Start at login is off (${r.kind}).`));
      }
      const r = await service.state();
      return console.log(`${r.kind}: ${yes(r.on)}${r.file ? ' · ' + r.file : ''}`);
    }
    case 'doctor': return doctor();
    case 'uninstall': return uninstall();
    case 'version': case 'v': return console.log(P.version());
    case 'help': case 'h': return console.log(HELP());
    default: console.error(T(`모르는 명령입니다: ${cmd}\n`, `Unknown command: ${cmd}\n`)); console.log(HELP()); process.exit(2);
  }
}

main().catch(e => die('fiche: ' + (e?.stack || e), 1));
