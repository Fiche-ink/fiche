// fiche PC client: frameless window over ui/, tray, local proxy, Claude Code connection.
const { app, BrowserWindow, Tray, safeStorage, Menu, ipcMain, nativeImage, shell, dialog, Notification } = require('electron');
const fs = require('fs'), path = require('path');
const { createProxy, PORT } = require('./proxy');
const claude = require('./claude');
const server = require('./server');
const engine = require('./engine');
const account = require('./account');
const meter = require('./meter');
const net = require('./net');
const startup = require('./startup');
const os = require('os');

const PROXY_URL = `http://127.0.0.1:${PORT}`;
const ICON = path.join(__dirname, 'assets', 'icon.png');

// Setup, uninstall and quit requests run their own short flows (src/setup.js).
if (require('./setup').handles()) return;
if (!app.requestSingleInstanceLock()) { app.quit(); return; }

// ---- config (userData/config.json) ----
const CFG_FILE = () => path.join(app.getPath('userData'), 'config.json');
let cfg = { proxyOn: true, connected: false, upstream: null, shareSignals: true };
function loadCfg() {
  try { cfg = { ...cfg, ...JSON.parse(fs.readFileSync(CFG_FILE(), 'utf8')) }; } catch { }
  // 11-18: "사용 통계 보내기" became the single "데이터 기여" switch.
  if (typeof cfg.contrib !== 'boolean') cfg.contrib = cfg.shareSignals !== false;
  delete cfg.shareSignals; delete cfg.installToken;
}
function saveCfg() { fs.mkdirSync(path.dirname(CFG_FILE()), { recursive: true }); fs.writeFileSync(CFG_FILE(), JSON.stringify(cfg, null, 2)); }
// UI language: chosen in the installer (config.json "lang"), else the Windows display language.
const lang = () => cfg.lang === 'en' || cfg.lang === 'ko' ? cfg.lang : (app.getLocale().toLowerCase().startsWith('ko') ? 'ko' : 'en');
const T = (ko, en) => lang() === 'en' ? en : ko;

const proxy = createProxy(() => cfg, async () => ({ version: app.getVersion(), store: startup.isStore, startup: await startup.get() }));
let proxyError = null, win = null, tray = null, quitting = false;

function createWindow() {
  win = new BrowserWindow({
    width: 1040, height: 680, useContentSize: true, minWidth: 900, minHeight: 600,
    frame: false, show: false, backgroundColor: '#ffffff', title: 'fiche', icon: ICON,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  win.removeMenu();
  // ui/ draws a fixed 1040x680 mock window; inside the app it fills the real window instead.
  win.webContents.on('dom-ready', () => win.webContents.insertCSS('html, body { margin: 0; height: 100%; overflow: hidden; } .win { width: 100vw !important; height: 100vh !important; }'));
  win.loadFile(path.join(__dirname, '..', 'ui', 'index.html'));
  // Started by Windows at sign-in: stay in the tray. The MSIX startup task cannot pass --hidden,
  // so a packaged launch in the first minutes after boot counts as a sign-in start.
  const hidden = process.argv.includes('--hidden') || (startup.isStore && os.uptime() < 300);
  win.once('ready-to-show', () => { if (!hidden) win.show(); });
  win.on('close', e => { if (!quitting) { e.preventDefault(); win.hide(); } });
  // Links open in the browser, never inside the app window.
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('file:')) { e.preventDefault(); if (/^https?:/.test(url)) shell.openExternal(url); } });
}

function showWindow() { if (!win) createWindow(); win.show(); win.focus(); }

const trayMenu = () => Menu.buildFromTemplate([
    { label: T('fiche 열기', 'Open fiche'), click: showWindow },
    { type: 'separator' },
    { label: T('종료', 'Quit'), click: () => { quitting = true; app.quit(); } },
  ]);
function createTray() {
  tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }));
  tray.setToolTip('fiche');
  tray.setContextMenu(trayMenu());
  tray.on('click', showWindow);
}

async function status() {
  let connected = false, claudeError = null;
  try { connected = claude.isConnected(PROXY_URL); } catch (e) { claudeError = e.message; }
  return {
    version: app.getVersion(), port: PORT, proxyOn: cfg.proxyOn, proxyListening: !proxyError, proxyError,
    connected, claudeError, claudeFound: claudeInstalled(), autoConnect: cfg.autoConnect !== false, settingsFile: claude.FILE, upstream: cfg.upstream || 'https://api.anthropic.com',
    autostart: (await startup.get()).on, store: startup.isStore, server: { base: server.BASE, ...server.lastStatus() },
    stats: proxy.stats, engine: engine.info(), contrib: cfg.contrib !== false, plan: cfg.plan || null, account: account.info(), limits: proxy.limits(),
  };
}

function setClaude(on) {
  if (on) {
    const { prev } = claude.connect(PROXY_URL);
    if (prev !== undefined) cfg.upstream = prev; // null = Anthropic directly
  } else claude.disconnect(PROXY_URL, cfg.upstream);
  cfg.connected = on; saveCfg();
}

// Claude Code is installed if its config folder exists or the `claude` command is on PATH
// (native installer: ~/.local/bin/claude.exe; npm: claude.cmd).
function claudeInstalled() {
  const home = os.homedir();
  if (fs.existsSync(path.join(home, '.claude')) || fs.existsSync(path.join(home, '.claude.json'))) return true;
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
  const dirs = (process.env.PATH || '').split(path.delimiter).concat(path.join(home, '.local', 'bin'));
  return dirs.some(d => d && exts.some(e => fs.existsSync(path.join(d, 'claude' + e))));
}

// Connect Claude Code on its own: at launch and every 30 s (so a Claude Code installed while
// fiche runs gets connected too). Turning the switch off by hand sets cfg.autoConnect = false,
// and fiche never reconnects on its own after that.
function autoConnect() {
  if (cfg.autoConnect === false || proxyError) return;
  let on;
  try { on = claude.isConnected(PROXY_URL); } catch { return; }
  if (on) { if (!cfg.connected) { cfg.connected = true; saveCfg(); } return; }
  if (!claudeInstalled()) return;
  try { setClaude(true); } catch (e) { console.error('auto connect', e); return; }
  try { if (win && !win.isDestroyed()) win.webContents.send('claude:update', true); } catch { }
  try {
    if (Notification.isSupported()) new Notification({
      title: T('Claude Code 자동 연결', 'Claude Code connected'), icon: ICON,
      body: T('자동으로 연결됐습니다. 열려 있는 Claude Code 창은 다시 시작해야 적용됩니다.', 'fiche connected automatically. Claude Code windows that are already open pick it up after a restart.'),
    }).show();
  } catch { }
}

ipcMain.handle('win', (_e, action) => {
  if (!win) return;
  if (action === 'min') win.minimize();
  else if (action === 'max') win.isMaximized() ? win.unmaximize() : win.maximize();
  else if (action === 'close') win.hide();
});
ipcMain.handle('status', () => status());
ipcMain.handle('proxy:set', (_e, on) => { cfg.proxyOn = !!on; saveCfg(); return status(); });
ipcMain.handle('claude:set', (_e, on) => { cfg.autoConnect = !!on;
  try { setClaude(!!on); return status(); }
  catch (e) { dialog.showErrorBox('fiche', e.message); return status(); }
});
ipcMain.on('lang:get', e => { e.returnValue = lang(); });
ipcMain.handle('lang:set', (_e, l) => {
  if (l !== 'ko' && l !== 'en') return lang();
  cfg.lang = l; saveCfg(); if (tray) tray.setContextMenu(trayMenu());
  if (win && !win.isDestroyed()) win.webContents.reload();
  return lang();
});
ipcMain.handle('contrib:set', async (_e, on) => {
  cfg.contrib = !!on; saveCfg(); engine.setup(cfg, account.key());
  if (account.signedIn()) await account.setProfile({ contrib: cfg.contrib }).catch(() => {});
  return status();
});
// Plan is asked once after sign-in (handoff 4.3); film sizes are fitted to real plans.
ipcMain.handle('plan:set', async (_e, plan) => {
  if (!['pro', 'max5', 'max10'].includes(plan)) return status();
  cfg.plan = plan; saveCfg();
  if (account.signedIn()) await account.setProfile({ plan }).catch(() => {});
  return status();
});
ipcMain.handle('account:signin', async () => {
  try { await account.signIn(url => shell.openExternal(url)); }
  catch (e) { return { ...(await status()), signInError: String(e?.message || e) }; }
  await afterSignIn();
  return status();
});
ipcMain.handle('account:cancel', () => { account.cancelSignIn(); return status(); });
ipcMain.handle('account:signout', async () => { await account.signOut(); engine.setToken(null); return status(); });
ipcMain.handle('account:refresh', async () => { await account.refresh(true).catch(() => {}); return status(); });
ipcMain.handle('stats:get', () => meter.summary());
ipcMain.handle('page:latest', () => engine.latestPage());
ipcMain.handle('netlog:get', () => net.list());
net.on('sent', e => { try { if (win && !win.isDestroyed()) win.webContents.send('netlog:update', e); } catch { } });
// Every compressed request is pushed to the window so the home screen can show it live.
meter.on('update', r => {
  try {
    if (tray) {
      const t = meter.summary().today;
      tray.setToolTip(t.before > t.after ? T('fiche · 오늘 ' + (t.before - t.after).toLocaleString('ko-KR') + ' 토큰을 아꼈습니다', 'fiche · ' + (t.before - t.after).toLocaleString('en-US') + ' tokens saved today') : 'fiche');
    }
  } catch { }
  if (r.saved > 0 && !cfg.firstSavedNotified) {
    cfg.firstSavedNotified = true; saveCfg();
    try {
      if (Notification.isSupported()) {
        const pct = Math.round((r.saved / (r.before || 1)) * 100);
        const n = new Notification({
          title: T('fiche · 첫 요청을 줄였습니다', 'fiche · First request trimmed'), icon: ICON,
          body: T(`${r.before.toLocaleString('ko-KR')} → ${r.after.toLocaleString('ko-KR')} 토큰 (-${pct}%). 이제 조용히 계속 줄입니다.`,
            `${r.before.toLocaleString('en-US')} → ${r.after.toLocaleString('en-US')} tokens (-${pct}%). fiche will keep running quietly in the tray.`),
        });
        n.on('click', showWindow);
        n.show();
      }
    } catch { }
  }
  try { if (win && !win.isDestroyed()) win.webContents.send('stats:update', r); } catch { }
});
ipcMain.handle('autostart:set', async (_e, on) => {
  const r = await startup.set(!!on);
  if (on && !r.on && r.state === 'DisabledByUser')
    dialog.showMessageBox(win, { type: 'info', title: 'fiche', message: T('Windows 시작 프로그램에서 fiche가 꺼져 있습니다.', 'fiche is turned off in Startup apps.'), detail: T('Windows 설정 > 앱 > 시작 프로그램에서 다시 켜 주세요.', 'Turn it back on in Windows Settings > Apps > Startup.') });
  return status();
});
ipcMain.handle('open:external', (_e, url) => { if (/^https:\/\//.test(url)) shell.openExternal(url); });

app.on('second-instance', (_e, argv) => {
  // `fiche.exe --quit` / `--uninstall` from the installer: close cleanly so Claude Code settings are restored.
  if (argv.includes('--quit') || argv.includes('--uninstall')) { quitting = true; app.quit(); return; }
  showWindow();
});
app.on('window-all-closed', () => { /* stay in tray */ });
app.on('before-quit', () => {
  engine.flush();
  quitting = true;
  // Claude Code cannot reach a closed proxy, so put settings.json back while fiche is not running.
  if (cfg.connected) { try { claude.disconnect(PROXY_URL, cfg.upstream); } catch { } }
});

// After sign-in (or at start when already signed in): hand the key to the engine, push the
// settings the server keeps (plan, data contribution), refresh the film balance.
async function afterSignIn() {
  engine.setToken(account.key());
  const patch = { contrib: cfg.contrib !== false };
  if (cfg.plan) patch.plan = cfg.plan;
  await account.setProfile(patch).catch(() => {});
  await account.refresh(true).catch(() => {});
  reportUsage();
}
// Every 6 hours, only while data contribution is on: plan, pixels drawn in the last 7 days
// and Claude's own limit readings, so film sizes can be fitted to real plans (handoff 4.3).
let lastReport = 0;
function reportUsage() {
  if (!account.signedIn() || cfg.contrib === false) return;
  if (Date.now() - lastReport < 5.5 * 3600e3) return;
  lastReport = Date.now();
  const s = meter.summary();
  account.report({ plan: cfg.plan || null, week_px: s.week?.px || 0, limits: proxy.limits(), app: app.getVersion() }).catch(() => {});
}

app.whenReady().then(async () => {
  if (process.platform === 'win32') app.setAppUserModelId('ink.fiche.desktop');
  loadCfg();
  // First start after install: apply the installer's "start with Windows" choice.
  const auto = process.argv.find(x => x.startsWith('--autostart='));
  if (auto) startup.set(auto.endsWith('=1')).catch(() => {});
  // Engine paths, judge URL, the signed-in account's key, data contribution flag.
  account.init(app.getPath('userData'), safeStorage);
  account.on('change', a => { try { if (win && !win.isDestroyed()) win.webContents.send('account:update', a); } catch { } });
  meter.init(app.getPath('userData'));
  try { engine.setup(cfg, account.key()); saveCfg(); engine.load().catch(() => {}); } catch (e) { console.error('engine setup', e); }
  try { await proxy.listen(); }
  catch (e) { proxyError = e.code === 'EADDRINUSE' ? T(`포트 ${PORT}번을 다른 프로그램이 쓰고 있습니다.`, `Port ${PORT} is used by another program.`) : String(e.message || e); }
  autoConnect();
  setInterval(autoConnect, 30000);
  if (account.signedIn()) afterSignIn().catch(() => {});
  setInterval(reportUsage, 6 * 3600e3);
  createTray();
  createWindow();
});
