// fiche PC client: frameless window over ui/, tray, local proxy, Claude Code connection.
const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, shell, dialog, Notification } = require('electron');
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

if (!app.requestSingleInstanceLock()) { app.quit(); return; }

// ---- config (userData/config.json) ----
const CFG_FILE = () => path.join(app.getPath('userData'), 'config.json');
let cfg = { proxyOn: true, connected: false, upstream: null, shareSignals: true };
function loadCfg() { try { cfg = { ...cfg, ...JSON.parse(fs.readFileSync(CFG_FILE(), 'utf8')) }; } catch { } }
function saveCfg() { fs.mkdirSync(path.dirname(CFG_FILE()), { recursive: true }); fs.writeFileSync(CFG_FILE(), JSON.stringify(cfg, null, 2)); }

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

function createTray() {
  tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }));
  tray.setToolTip('fiche');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'fiche 열기', click: showWindow },
    { type: 'separator' },
    { label: '종료', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('click', showWindow);
}

async function status() {
  let connected = false, claudeError = null;
  try { connected = claude.isConnected(PROXY_URL); } catch (e) { claudeError = e.message; }
  return {
    version: app.getVersion(), port: PORT, proxyOn: cfg.proxyOn, proxyListening: !proxyError, proxyError,
    connected, claudeError, claudeFound: claudeInstalled(), autoConnect: cfg.autoConnect !== false, settingsFile: claude.FILE, upstream: cfg.upstream || 'https://api.anthropic.com',
    autostart: (await startup.get()).on, store: startup.isStore, server: { base: server.BASE, ...server.lastStatus() },
    stats: proxy.stats, engine: engine.info(), shareSignals: cfg.shareSignals !== false,
    account: { signedIn: !!cfg.apiKey, email: cfg.accountEmail || null, keyHint: cfg.apiKey ? cfg.apiKey.slice(0, 6) + '…' + cfg.apiKey.slice(-4) : null },
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
      title: 'Claude Code 자동 연결', icon: ICON,
      body: '자동으로 연결됐어요. 열려 있는 Claude Code 창은 다시 시작해야 적용돼요.',
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
ipcMain.handle('signals:set', (_e, on) => { cfg.shareSignals = !!on; engine.setup(cfg); saveCfg(); return status(); });
// 11-17: sign-in through fiche's device flow (browser approves, app polls for an API key).
ipcMain.handle('stats:get', () => meter.summary());
ipcMain.handle('netlog:get', () => net.list());
net.on('sent', e => { try { if (win && !win.isDestroyed()) win.webContents.send('netlog:update', e); } catch { } });
// Every compressed request is pushed to the window so the home screen can show it live.
meter.on('update', r => { try { if (tray) { const t = meter.summary().today; tray.setToolTip(t.before > t.after ? 'fiche · 오늘 ' + (t.before - t.after).toLocaleString('ko-KR') + ' 토큰 아꼈어요' : 'fiche'); } } catch { } try { if (win && !win.isDestroyed()) win.webContents.send('stats:update', r); } catch { } });
ipcMain.handle('account:signin', async () => {
  const key = await account.signIn(url => shell.openExternal(url));
  const m = await account.me(key);
  cfg.apiKey = key; cfg.accountEmail = m?.email || null;
  engine.setup(cfg); saveCfg(); return status();
});
ipcMain.handle('account:signout', async () => {
  cfg.apiKey = null; cfg.accountEmail = null;
  engine.setup(cfg); saveCfg(); return status();
});
ipcMain.handle('autostart:set', async (_e, on) => {
  const r = await startup.set(!!on);
  if (on && !r.on && r.state === 'DisabledByUser')
    dialog.showMessageBox(win, { type: 'info', title: 'fiche', message: '시작 프로그램에서 fiche를 꺼 두셨어요.', detail: 'Windows 설정 > 앱 > 시작 프로그램에서 다시 켜 주세요.' });
  return status();
});
ipcMain.handle('open:external', (_e, url) => { if (/^https:\/\//.test(url)) shell.openExternal(url); });

app.on('second-instance', showWindow);
app.on('window-all-closed', () => { /* stay in tray */ });
app.on('before-quit', () => {
  engine.flush();
  quitting = true;
  // Claude Code cannot reach a closed proxy, so put settings.json back while fiche is not running.
  if (cfg.connected) { try { claude.disconnect(PROXY_URL, cfg.upstream); } catch { } }
});

app.whenReady().then(async () => {
  if (process.platform === 'win32') app.setAppUserModelId('ink.fiche.desktop');
  loadCfg();
  // OBT: engine paths, judge URL, anonymous install token, signal opt-out flag.
  meter.init(app.getPath('userData'));
  try { engine.setup(cfg); saveCfg(); engine.load().catch(() => {}); } catch (e) { console.error('engine setup', e); }
  // A revoked key falls back to the anonymous install token.
  if (cfg.apiKey) account.me(cfg.apiKey).then(m => { if (m?.invalid) { cfg.apiKey = null; cfg.accountEmail = null; engine.setup(cfg); saveCfg(); } else if (m?.email) { cfg.accountEmail = m.email; saveCfg(); } }).catch(() => {});
  try { await proxy.listen(); }
  catch (e) { proxyError = e.code === 'EADDRINUSE' ? `포트 ${PORT}를 다른 프로그램이 쓰고 있어요.` : String(e.message || e); }
  autoConnect();
  setInterval(autoConnect, 30000);
  server.account().then(r => console.log('fiche server:', r.status));
  createTray();
  createWindow();
});
