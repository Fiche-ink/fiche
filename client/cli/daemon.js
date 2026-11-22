// fiche daemon: the PC client without a window (macOS, Linux, WSL2).
//
// It does exactly what src/main.js does in the GUI app, minus the UI: run the local proxy on
// 127.0.0.1:47321, compress each /v1/messages body with the bundled engine, keep Claude Code's
// settings.json pointed at the proxy while it is running, and put it back on the way out.
// `fiche <command>` talks to this process over a unix socket (cli/control.js).
const fs = require('fs'), path = require('path'), os = require('os');
const P = require('./paths'), control = require('./control'), plat = require('./platform');
const ui = require('./ui'), hook = require('./hook'), win = require('./window'), service = require('./service');

const C = P.clientDir();
const req = name => require(path.join(C, name + '.js'));
const { createProxy, PORT } = req('proxy');
const claude = req('claude');
const mitm = req('mitm');
const server = req('server');
const engine = req('engine');
const account = req('account');
const meter = req('meter');
const net = req('net');
const preview = req('preview');

let PROXY_URL = `http://127.0.0.1:${PORT}`, portMovedFrom = null;
const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---- config (same file name and shape as the GUI app's userData/config.json) ----
const CFG_FILE = path.join(P.dataDir, 'config.json');
let cfg = { proxyOn: true, connected: false, upstream: null, contrib: true };
function loadCfg() {
  try { cfg = { ...cfg, ...JSON.parse(fs.readFileSync(CFG_FILE, 'utf8')) }; } catch { }
  if (typeof cfg.contrib !== 'boolean') cfg.contrib = cfg.shareSignals !== false;
  delete cfg.shareSignals; delete cfg.installToken;
}
function saveCfg() {
  fs.mkdirSync(path.dirname(CFG_FILE), { recursive: true });
  fs.writeFileSync(CFG_FILE, JSON.stringify(cfg, null, 2));
}

let proxyError = null, quitting = false;
const proxy = createProxy(() => cfg, async () => ({ version: P.version(), cli: true }));

// Screen language: `fiche ui`'s own switch (cfg.lang), else the shell's locale.
const lang = () => cfg.lang === 'en' || cfg.lang === 'ko' ? cfg.lang
  : /^ko/i.test(process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || '') ? 'ko' : 'en';
const T = (ko, en) => lang() === 'en' ? en : ko;

// ---- Claude Code connection ----
function setClaude(on) {
  if (on) {
    const { prev } = claude.connect(PROXY_URL);
    if (prev !== undefined) cfg.upstream = prev; // null = Anthropic directly
  } else claude.disconnect(PROXY_URL, cfg.upstream);
  cfg.connected = on; saveCfg();
  syncHook();
}

// The SessionStart hook is there exactly while Claude Code is connected, the window app is
// installed and "open with Claude Code" is on.
function syncHook() {
  const want = !!cfg.connected && cfg.openWithClaude !== false && !!win.find();
  try {
    if (want && !hook.installed()) hook.add();
    else if (!want && hook.installed()) hook.remove();
  } catch (e) { log('hook:', e.message); }
}

// Claude Code is installed if its config folder exists or `claude` is on PATH
// (native installer: ~/.local/bin/claude).
function claudeInstalled() {
  const home = os.homedir();
  if (fs.existsSync(path.join(home, '.claude')) || fs.existsSync(path.join(home, '.claude.json'))) return true;
  const dirs = (process.env.PATH || '').split(path.delimiter).concat(path.join(home, '.local', 'bin'));
  return dirs.some(d => d && fs.existsSync(path.join(d, 'claude')));
}

// Same rule as the GUI: connect at launch and every 30 s, but never again once the user has
// turned the connection off by hand (cfg.autoConnect === false).
function autoConnect() {
  if (cfg.autoConnect === false || proxyError) return;
  let on;
  try { on = claude.isConnected(PROXY_URL); } catch { return; }
  if (on) { if (!cfg.connected) { cfg.connected = true; saveCfg(); } syncHook(); return; }
  if (!claudeInstalled()) return;
  try { setClaude(true); log('connected Claude Code:', claude.FILE); } catch (e) { log('auto connect failed:', e.message); return; }
  ui.broadcast('claude:update', true);
  win.notify(T('Claude Code 자동 연결', 'Claude Code connected'),
    T('자동으로 연결됐습니다. 열려 있는 Claude Code 창은 다시 시작해야 적용됩니다.', 'fiche connected automatically. Claude Code windows that are already open pick it up after a restart.'));
}

// "Start at login" is the service (cli/service.js). Asking launchctl or systemctl takes a few
// milliseconds and the screen polls status, so the answer is kept for a while.
let autostartCache = null;
async function autostart() {
  if (autostartCache && Date.now() - autostartCache.at < 15000) return autostartCache.on;
  let on = false;
  try { on = !!(await service.state()).on; } catch { }
  autostartCache = { on, at: Date.now() };
  return on;
}

// Installing or removing the service restarts this daemon (cli/fiche.js `service`), so it runs
// in a process of its own: detached for launchd and the shell rc file, and in a transient unit
// for systemd, which would otherwise stop it along with everything else in fiche.service.
async function setAutostart(on) {
  const sub = on ? 'install' : 'uninstall';
  const kind = await service.kind();
  const ok = kind === 'systemd'
    ? await plat.spawnOk('systemd-run', ['--user', '--collect', '--quiet', P.launcher(), 'service', sub])
    : await plat.spawnOk(P.launcher(), ['service', sub]);
  if (ok) autostartCache = { on, at: Date.now() };
  return status();
}

async function status() {
  let connected = false, claudeError = null;
  try { connected = claude.isConnected(PROXY_URL); } catch (e) { claudeError = e.message; }
  const w = plat.wsl();
  return {
    version: P.version(), cli: true, pid: process.pid, platform: process.platform, arch: process.arch,
    wsl: w ? { distro: w.distro } : null,
    port: proxy.port(), portMovedFrom, keepDays: cfg.keepDays ?? 30, proxyOn: cfg.proxyOn, proxyListening: !proxyError, proxyError,
    connected, claudeError, claudeFound: claudeInstalled(), autoConnect: cfg.autoConnect !== false,
    settingsFile: claude.FILE, upstream: cfg.upstream || 'https://api.anthropic.com',
    server: { base: server.BASE, ...server.lastStatus() },
    stats: proxy.stats, engine: engine.info(), contrib: cfg.contrib !== false,
    plan: cfg.plan || null, account: account.info(), limits: proxy.limits(),
    autostart: await autostart(), window: !!win.find(), openWithClaude: cfg.openWithClaude !== false,
    dataDir: P.dataDir, logFile: P.logFile,
  };
}

// ---- app screen (cli/ui.js) ----
// window.fiche calls from the screen. Same names and results as the Windows app's ipcMain handlers.
async function uiCall(method, arg) {
  switch (method) {
    case 'status': return status();
    case 'win': return null;
    case 'lang:set': if (arg === 'ko' || arg === 'en') { cfg.lang = arg; saveCfg(); } return lang();
    case 'proxy:set': return handle('proxy', { on: !!arg });
    case 'claude:set': return handle(arg ? 'connect' : 'disconnect');
    case 'autostart:set': return setAutostart(!!arg);
    case 'contrib:set': return handle('contrib', { on: !!arg });
    case 'keep:set': return handle('keep', { days: arg });
    case 'plan:set': return handle('plan', { plan: arg });
    case 'account:signin':
      try { await account.signIn(u => { plat.openUrl(u); }); }
      catch (e) { return { ...(await status()), signInError: String(e?.message || e) }; }
      await afterSignIn();
      return status();
    case 'account:cancel': account.cancelSignIn(); return status();
    case 'account:signout': return handle('logout');
    case 'account:refresh': return handle('refresh');
    case 'stats:get': return meter.summary();
    case 'page:latest': return engine.latestPage();
    case 'netlog:get': return net.list();
    case 'preview:get': return preview.get();
    case 'preview:run': preview.run({ root: engine.info().root, token: account.key() }); return preview.get() || { running: true };
    case 'open:external': if (typeof arg === 'string' && /^https:\/\//.test(arg)) await plat.openUrl(arg); return null;
    default: throw Object.assign(new Error('unknown method'), { code: 'EUNKNOWN' });
  }
}

// `fiche ui`: the window app if it is installed, else the browser. From the SessionStart hook
// (session: true) only the window app, and only when no screen is open yet, so starting more
// Claude Code sessions does not pull fiche to the front each time.
async function openScreen(session, env) {
  const url = ui.url();
  if (!url) return { error: 'screen not running' };
  if (session) {
    if (cfg.openWithClaude === false || ui.viewers() > 0 || !win.find()) return { opened: false };
    return { opened: await win.launch(url, env) };
  }
  if (await win.launch(url, env)) return { opened: 'window' };
  return { opened: (await plat.openUrl(url)) ? 'browser' : false, url };
}

// ---- account ----
// Plan and data contribution come from the server and are only sent when the user changes them,
// so a fresh install or a second machine never overwrites the account's choice.
async function afterSignIn() {
  engine.setToken(account.key());
  const me = await account.refresh(true).catch(() => null);
  if (me?.film) {
    if (typeof me.film.contrib === 'boolean') cfg.contrib = me.film.contrib;
    cfg.plan = me.film.plan || null;
    saveCfg();
    engine.setup(cfg, account.key());
  }
  reportUsage();
}
let lastReport = 0;
function reportUsage() {
  if (!account.signedIn() || cfg.contrib === false) return;
  if (Date.now() - lastReport < 5.5 * 3600e3) return;
  lastReport = Date.now();
  const s = meter.summary();
  account.report({ plan: cfg.plan || null, week_px: s.week?.px || 0, limits: proxy.limits(), app: `cli ${P.version()}` }).catch(() => { });
}

// Sign-in runs here, not in the CLI process: the daemon owns the key and the engine that needs it.
// `fiche login` asks for the URL, opens the browser, then polls status.
let signInUrl = null, signInError = null;
function startSignIn() {
  if (account.signedIn()) return Promise.resolve({ signedIn: true });
  signInUrl = null; signInError = null;
  account.signIn(url => { signInUrl = url; })
    .then(() => { signInError = null; return afterSignIn(); })
    .catch(e => { signInError = String(e?.message || e); log('sign-in failed:', signInError); });
  // The URL appears once account.js has its loopback server listening (a tick or two away).
  return new Promise(ok => {
    const t0 = Date.now();
    const tick = () => (signInUrl || signInError || Date.now() - t0 > 8000)
      ? ok({ url: signInUrl, error: signInError }) : setTimeout(tick, 50);
    tick();
  });
}

// ---- control commands ----
// The server copy follows the account to other PCs, so a save that fails there changes nothing here.
async function saveProfile(patch) {
  if (!account.signedIn()) return true;
  const r = await account.setProfile(patch).catch(() => null);
  return !!r?.ok;
}

async function handle(action, args) {
  switch (action) {
    case 'ping': return { ok: true, pid: process.pid, version: P.version() };
    case 'status': return status();
    case 'proxy': cfg.proxyOn = !!args.on; saveCfg(); return status();
    case 'connect': case 'disconnect': {
      const on = action === 'connect';
      if (on && proxyError) return { ...(await status()), error: proxyError };
      cfg.autoConnect = on; setClaude(on);
      return status();
    }
    case 'contrib':
      if (!(await saveProfile({ contrib: !!args.on }))) return { ...(await status()), profileError: true };
      cfg.contrib = !!args.on; saveCfg(); engine.setup(cfg, account.key());
      return status();
    case 'keep':
      if ([14, 30, 0].includes(args.days)) { cfg.keepDays = args.days; saveCfg(); engine.setup(cfg, account.key()); }
      return status();
    case 'plan':
      if (!['pro', 'max5', 'max10'].includes(args.plan)) return status();
      if (!(await saveProfile({ plan: args.plan }))) return { ...(await status()), profileError: true };
      cfg.plan = args.plan; saveCfg();
      return status();
    case 'login': return startSignIn();
    case 'login:cancel': account.cancelSignIn(); return { ok: true };
    case 'logout': await account.signOut(); engine.setToken(null); cfg.plan = null; saveCfg(); return status();
    case 'refresh': await account.refresh(true).catch(() => { }); return status();
    case 'stats': return meter.summary();
    case 'netlog': return net.list().slice(0, args.limit || 30);
    case 'page': return engine.latestPage();
    case 'ui': return { url: ui.url(), window: win.find()?.path || null, viewers: ui.viewers(), openWithClaude: cfg.openWithClaude !== false };
    case 'ui:open': return openScreen(!!args.session, args.env);
    case 'ui:with-claude': cfg.openWithClaude = !!args.on; saveCfg(); syncHook(); return { openWithClaude: cfg.openWithClaude, hook: hook.installed() };
    case 'quit': setTimeout(() => shutdown(0), 50); return { ok: true };
    default: return { error: 'unknown_action' };
  }
}

// ---- lifecycle ----
let srv = null;
async function shutdown(code) {
  if (quitting) return;
  quitting = true;
  try { await engine.flush(); } catch { }
  // Claude Code cannot reach a closed proxy, so settings.json goes back while fiche is not running.
  if (cfg.connected) { try { claude.disconnect(PROXY_URL, cfg.upstream); log('restored', claude.FILE); } catch (e) { log('restore failed:', e.message); } }
  try { hook.remove(); } catch { }
  try { ui.close(); } catch { }
  try { srv?.close(); } catch { }
  try { await proxy.close(); } catch { }
  try { fs.rmSync(P.pidFile, { force: true }); } catch { }
  process.exit(code);
}

async function main() {
  P.ensure();
  loadCfg();
  account.init(P.dataDir, null); // no Electron safeStorage: the key file is written 0600 (account.js)
  meter.init(P.dataDir);
  preview.init(P.dataDir);
  preview.on('update', r => ui.broadcast('preview:update', r));
  // Someone upgrading from a CLI without notifications has had their first trimmed request long ago.
  if (!cfg.firstSavedNotified) { try { if ((meter.summary().total?.imaged || 0) > 0) { cfg.firstSavedNotified = true; saveCfg(); } } catch { } }
  try { engine.setup(cfg, account.key()); saveCfg(); engine.load().catch(e => log('engine load:', e.message)); }
  catch (e) { log('engine setup failed:', e.message); }

  try { srv = await control.listen(handle); }
  catch (e) {
    // Another daemon already owns the socket (a hand-started one, or the service starting a
    // second copy). Nothing to do, and exiting 0 matters: launchd and systemd restart a daemon
    // that fails, so a non-zero exit here would loop forever every few seconds.
    if (e.code === 'ERUNNING') { log('another fiche is already running; nothing to do'); process.exit(0); }
    throw e;
  }
  try {
    const was = cfg.port || PORT, port = await proxy.listen(cfg.port);
    PROXY_URL = `http://127.0.0.1:${port}`;
    if (port !== was) { portMovedFrom = was; cfg.port = port; saveCfg(); log(`port ${was} is in use, moved to ${port}`); }
    // HTTPS_PROXY mode for Claude Desktop (mitm.js); without it the base-URL connection still works.
    try { const ca = mitm.loadCA(P.dataDir); proxy.mitm(ca); claude.useCA({ ca: ca.file, bundle: path.join(P.dataDir, 'claude-ca.pem') }); }
    catch (e) { log('https proxy mode off:', e.message); }
    log(`proxy on ${PROXY_URL}`);
  }
  catch (e) {
    proxyError = e.code === 'EADDRINUSE' ? `port ${PORT} and its spares are all used by other programs` : String(e.message || e);
    log('proxy failed:', proxyError);
  }
  fs.writeFileSync(P.pidFile, String(process.pid));
  try { log('screen on', (await ui.listen({ call: uiCall, lang, log })).replace(/\?t=.*/, '')); }
  catch (e) { log('screen failed:', e.message); }

  account.on('change', a => ui.broadcast('account:update', a));
  net.on('sent', e => ui.broadcast('netlog:update', e));
  meter.on('update', r => {
    if (r.saved > 0) log(`request ${r.before} -> ${r.after} tokens (-${Math.round(r.saved / (r.before || 1) * 100)}%)`);
    ui.broadcast('stats:update', r);
    if (r.saved > 0 && !cfg.firstSavedNotified) {
      cfg.firstSavedNotified = true; saveCfg();
      const pct = Math.round((r.saved / (r.before || 1)) * 100), loc = lang() === 'en' ? 'en-US' : 'ko-KR';
      win.notify(T('fiche · 첫 요청을 줄였습니다', 'fiche · First request trimmed'),
        T(`${r.before.toLocaleString(loc)} → ${r.after.toLocaleString(loc)} 토큰 (-${pct}%). 이제 조용히 계속 줄입니다.`,
          `${r.before.toLocaleString(loc)} → ${r.after.toLocaleString(loc)} tokens (-${pct}%). fiche keeps going quietly in the background.`));
    }
  });

  autoConnect();
  setInterval(autoConnect, 30000).unref?.();
  if (account.signedIn()) afterSignIn().catch(() => { });
  setInterval(reportUsage, 6 * 3600e3).unref?.();

  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => shutdown(0));
  process.on('uncaughtException', e => { log('uncaught:', e?.stack || e); });
  log(`fiche ${P.version()} (cli) ready; data ${P.dataDir}`);
  // Keep the process alive even though every timer above is unref'd.
  setInterval(() => { }, 1 << 30);
}

module.exports = { main };
