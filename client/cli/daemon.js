// fiche daemon: the PC client without a window (macOS, Linux, WSL2).
//
// It does exactly what src/main.js does in the GUI app, minus the UI: run the local proxy on
// 127.0.0.1:47321, compress each /v1/messages body with the bundled engine, keep Claude Code's
// settings.json pointed at the proxy while it is running, and put it back on the way out.
// `fiche <command>` talks to this process over a unix socket (cli/control.js).
const fs = require('fs'), path = require('path'), os = require('os');
const P = require('./paths'), control = require('./control'), plat = require('./platform');

const C = P.clientDir();
const req = name => require(path.join(C, name + '.js'));
const { createProxy, PORT } = req('proxy');
const claude = req('claude');
const server = req('server');
const engine = req('engine');
const account = req('account');
const meter = req('meter');
const net = req('net');

const PROXY_URL = `http://127.0.0.1:${PORT}`;
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

// ---- Claude Code connection ----
function setClaude(on) {
  if (on) {
    const { prev } = claude.connect(PROXY_URL);
    if (prev !== undefined) cfg.upstream = prev; // null = Anthropic directly
  } else claude.disconnect(PROXY_URL, cfg.upstream);
  cfg.connected = on; saveCfg();
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
  if (on) { if (!cfg.connected) { cfg.connected = true; saveCfg(); } return; }
  if (!claudeInstalled()) return;
  try { setClaude(true); log('connected Claude Code:', claude.FILE); } catch (e) { log('auto connect failed:', e.message); }
}

async function status() {
  let connected = false, claudeError = null;
  try { connected = claude.isConnected(PROXY_URL); } catch (e) { claudeError = e.message; }
  const w = plat.wsl();
  return {
    version: P.version(), cli: true, pid: process.pid, platform: process.platform, arch: process.arch,
    wsl: w ? { distro: w.distro } : null,
    port: PORT, proxyOn: cfg.proxyOn, proxyListening: !proxyError, proxyError,
    connected, claudeError, claudeFound: claudeInstalled(), autoConnect: cfg.autoConnect !== false,
    settingsFile: claude.FILE, upstream: cfg.upstream || 'https://api.anthropic.com',
    server: { base: server.BASE, ...server.lastStatus() },
    stats: proxy.stats, engine: engine.info(), contrib: cfg.contrib !== false,
    plan: cfg.plan || null, account: account.info(), limits: proxy.limits(),
    dataDir: P.dataDir, logFile: P.logFile,
  };
}

// ---- account ----
async function afterSignIn() {
  engine.setToken(account.key());
  const patch = { contrib: cfg.contrib !== false };
  if (cfg.plan) patch.plan = cfg.plan;
  await account.setProfile(patch).catch(() => { });
  await account.refresh(true).catch(() => { });
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
async function handle(action, args) {
  switch (action) {
    case 'ping': return { ok: true, pid: process.pid, version: P.version() };
    case 'status': return status();
    case 'proxy': cfg.proxyOn = !!args.on; saveCfg(); return status();
    case 'connect': case 'disconnect': {
      const on = action === 'connect';
      cfg.autoConnect = on; setClaude(on);
      return status();
    }
    case 'contrib':
      cfg.contrib = !!args.on; saveCfg(); engine.setup(cfg, account.key());
      if (account.signedIn()) await account.setProfile({ contrib: cfg.contrib }).catch(() => { });
      return status();
    case 'plan':
      if (!['pro', 'max5', 'max10'].includes(args.plan)) return status();
      cfg.plan = args.plan; saveCfg();
      if (account.signedIn()) await account.setProfile({ plan: args.plan }).catch(() => { });
      return status();
    case 'login': return startSignIn();
    case 'login:cancel': account.cancelSignIn(); return { ok: true };
    case 'logout': await account.signOut(); engine.setToken(null); return status();
    case 'refresh': await account.refresh(true).catch(() => { }); return status();
    case 'stats': return meter.summary();
    case 'netlog': return net.list().slice(0, args.limit || 30);
    case 'page': return engine.latestPage();
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
  try { await proxy.listen(); log(`proxy on ${PROXY_URL}`); }
  catch (e) {
    proxyError = e.code === 'EADDRINUSE' ? `port ${PORT} is used by another program` : String(e.message || e);
    log('proxy failed:', proxyError);
  }
  fs.writeFileSync(P.pidFile, String(process.pid));

  autoConnect();
  setInterval(autoConnect, 30000).unref?.();
  if (account.signedIn()) afterSignIn().catch(() => { });
  setInterval(reportUsage, 6 * 3600e3).unref?.();
  meter.on('update', r => { if (r.saved > 0) log(`request ${r.before} -> ${r.after} tokens (-${Math.round(r.saved / (r.before || 1) * 100)}%)`); });

  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => shutdown(0));
  process.on('uncaughtException', e => { log('uncaught:', e?.stack || e); });
  log(`fiche ${P.version()} (cli) ready; data ${P.dataDir}`);
  // Keep the process alive even though every timer above is unref'd.
  setInterval(() => { }, 1 << 30);
}

module.exports = { main };
