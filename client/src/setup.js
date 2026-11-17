// Installer and uninstaller, inside the app itself.
//
// The download (fiche-setup-<version>.exe) is electron-builder's portable target: it unpacks
// the app to a temp folder and runs it with PORTABLE_EXECUTABLE_FILE set. In that mode the app
// shows only its own install screen (ui/setup.html), copies its unpacked folder to the chosen
// location, makes shortcuts and an "Installed apps" entry, then starts the installed copy.
//
// `fiche.exe --uninstall` (the UninstallString) reverses that, and `fiche.exe --quit` asks a
// running copy to quit so files can be replaced during an update.
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const ofs = require('original-fs'); // plain fs: copies app.asar as a file, not as a folder
const path = require('path'), os = require('os');
const { execFile, spawn } = require('child_process');

const KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\fiche';
const EXE = 'fiche.exe';
const AUMID = 'ink.fiche.desktop';
const LOCAL = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
const ROAMING = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const defaultDir = () => path.join(LOCAL, 'Programs', 'fiche');
const startMenuLnk = () => path.join(ROAMING, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'fiche.lnk');
const desktopLnk = () => path.join(app.getPath('desktop'), 'fiche.lnk');
const shots = process.env.FICHE_SETUP_SHOTS || ''; // test hook: save a PNG of each step here

const run = (file, args) => new Promise(ok => execFile(file, args, { windowsHide: true }, (err, out) => ok({ err, out: String(out || '') })));
const reg = args => run('reg.exe', args);
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function installedDir() {
  const { err, out } = await reg(['query', KEY, '/v', 'InstallLocation']);
  const m = !err && out.match(/InstallLocation\s+REG_SZ\s+(.+)/);
  return m ? m[1].trim() : null;
}

// Copy of the running exe in `dir`, if any: Get-Process by exact path.
async function runningIn(dir) {
  const exe = path.join(dir, EXE).replace(/'/g, "''");
  const { out } = await run('powershell.exe', ['-NoProfile', '-Command',
    `@(Get-Process -Name fiche -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq '${exe}' }).Count`]);
  return parseInt(out, 10) > 0;
}

// Ask a running installed copy to quit (it restores Claude Code settings on the way out);
// force it after 10 s.
async function stopInstalled(dir) {
  if (!(await runningIn(dir))) return;
  spawn(path.join(dir, EXE), ['--quit'], { env: cleanEnv(), detached: true, stdio: 'ignore', windowsHide: true }).unref();
  for (let i = 0; i < 20; i++) { await sleep(500); if (!(await runningIn(dir))) return; }
  const exe = path.join(dir, EXE).replace(/'/g, "''");
  await run('powershell.exe', ['-NoProfile', '-Command',
    `Get-Process -Name fiche -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq '${exe}' } | Stop-Process -Force`]);
  await sleep(800);
}

function walk(dir, base = dir, out = []) {
  for (const e of ofs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, base, out);
    else out.push({ rel: path.relative(base, p), size: ofs.statSync(p).size });
  }
  return out;
}

async function copyTree(src, dst, onProgress) {
  const files = walk(src), total = files.reduce((a, f) => a + f.size, 0);
  let done = 0, last = 0;
  for (const f of files) {
    const to = path.join(dst, f.rel);
    await ofs.promises.mkdir(path.dirname(to), { recursive: true });
    await ofs.promises.copyFile(path.join(src, f.rel), to);
    done += f.size;
    if (done - last > 4e6 || done === total) { last = done; onProgress(done, total); }
  }
  return total;
}

// Files that an older version left behind but this one no longer ships.
function prune(src, dst) {
  // Only inside an earlier fiche install, never a folder the user already had.
  if (!ofs.existsSync(path.join(dst, EXE))) return;
  const keep = new Set(walk(src).map(f => f.rel.toLowerCase()));
  for (const f of walk(dst)) if (!keep.has(f.rel.toLowerCase())) { try { ofs.unlinkSync(path.join(dst, f.rel)); } catch { } }
}

async function register(dir, bytes) {
  const exe = path.join(dir, EXE);
  const add = (name, type, value) => reg(['add', KEY, '/v', name, '/t', type, '/d', value, '/f']);
  await add('DisplayName', 'REG_SZ', 'fiche');
  await add('DisplayVersion', 'REG_SZ', app.getVersion());
  await add('Publisher', 'REG_SZ', 'fiche');
  await add('URLInfoAbout', 'REG_SZ', 'https://fiche.ink');
  await add('DisplayIcon', 'REG_SZ', exe);
  await add('InstallLocation', 'REG_SZ', dir);
  await add('UninstallString', 'REG_SZ', `"${exe}" --uninstall`);
  await add('EstimatedSize', 'REG_DWORD', String(Math.round(bytes / 1024)));
  await add('NoModify', 'REG_DWORD', '1');
  await add('NoRepair', 'REG_DWORD', '1');
}

function shortcut(file, dir, on) {
  try {
    if (!on) { if (ofs.existsSync(file)) ofs.unlinkSync(file); return; }
    ofs.mkdirSync(path.dirname(file), { recursive: true });
    shell.writeShortcutLink(file, 'create', { target: path.join(dir, EXE), cwd: dir, appUserModelId: AUMID, icon: path.join(dir, EXE), iconIndex: 0 });
  } catch { }
}

async function capture(win, name) {
  if (!shots || !win || win.isDestroyed()) return;
  try { await sleep(350); const img = await win.webContents.capturePage(); ofs.mkdirSync(shots, { recursive: true }); ofs.writeFileSync(path.join(shots, name + '.png'), img.toPNG()); } catch { }
}

// ---- install screen ----
// Environment for the installed copy. The portable wrapper's PORTABLE_EXECUTABLE_* variables
// (and the test hooks) must not leak into it, or it would start as the installer again.
function cleanEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^PORTABLE_EXECUTABLE_|^FICHE_SETUP_SHOTS/.test(k)) delete env[k];
  return env;
}

async function runSetup() {
  app.setAppUserModelId(AUMID);
  await app.whenReady();
  const existing = await installedDir();
  const win = new BrowserWindow({
    width: 600, height: 520, resizable: false, maximizable: false, frame: false, show: false,
    backgroundColor: '#f6f1ea', title: 'fiche 설치', icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'setup-preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  win.removeMenu();
  win.loadFile(path.join(__dirname, '..', 'ui', 'setup.html'));
  win.once('ready-to-show', () => { win.show(); if (shots) capture(win, '01-start').then(autoInstall); });
  win.webContents.on('will-navigate', e => e.preventDefault());

  let installed = null, busy = false;
  ipcMain.handle('setup:info', () => ({ version: app.getVersion(), dir: existing || defaultDir(), update: !!existing }));
  ipcMain.handle('setup:pick', async (_e, cur) => {
    const r = await dialog.showOpenDialog(win, { title: '설치할 폴더', defaultPath: cur, properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled || !r.filePaths[0]) return null;
    const p = r.filePaths[0];
    // Picking a parent such as D:\Apps installs into D:\Apps\fiche.
    return /[\\/]fiche$/i.test(p) ? p : path.join(p, 'fiche');
  });
  ipcMain.handle('setup:install', async (_e, o) => {
    if (busy) return { error: '이미 설치하는 중이에요.' };
    busy = true;
    try {
      const dir = path.resolve(String(o.dir || defaultDir()));
      const src = path.dirname(process.execPath);
      if (dir.toLowerCase() === src.toLowerCase()) throw new Error('설치 파일이 풀린 폴더에는 설치할 수 없어요.');
      const send = (done, total) => { if (!win.isDestroyed()) win.webContents.send('setup:progress', { done, total }); };
      send(0, 1);
      await stopInstalled(dir);
      if (existing && existing.toLowerCase() !== dir.toLowerCase()) await stopInstalled(existing);
      prune(src, dir);
      const bytes = await copyTree(src, dir, send);
      await register(dir, bytes);
      shortcut(desktopLnk(), dir, !!o.desktop);
      shortcut(startMenuLnk(), dir, !!o.startMenu);
      installed = { dir, autostart: !!o.autostart };
      return { ok: true };
    } catch (e) {
      return { error: String(e && e.message || e) };
    } finally { busy = false; }
  });
  ipcMain.handle('setup:open', () => {
    if (installed) spawn(path.join(installed.dir, EXE), ['--autostart=' + (installed.autostart ? 1 : 0)],
      { env: cleanEnv(), cwd: installed.dir, detached: true, stdio: 'ignore' }).unref();
    setTimeout(() => app.quit(), 300);
  });
  ipcMain.handle('setup:close', () => app.quit());
  app.on('window-all-closed', () => app.quit());

  // Test hook (FICHE_SETUP_SHOTS): click through the screen and save each step.
  async function autoInstall() {
    const wc = win.webContents;
    await wc.executeJavaScript("document.querySelector('#install').click()");
    await sleep(600); await capture(win, '02-progress');
    for (let i = 0; i < 240 && !installed; i++) await sleep(500);
    await sleep(500); await capture(win, '03-done');
    if (process.env.FICHE_SETUP_SHOTS_OPEN) await wc.executeJavaScript("document.querySelector('#open').click()");
    else app.quit();
  }
}

// ---- uninstall ----
async function runUninstall() {
  await app.whenReady();
  const dir = path.dirname(process.execPath);
  let wipe = false;
  if (!process.env.FICHE_UNINSTALL_YES) {
    const r = await dialog.showMessageBox({
      type: 'question', title: 'fiche 제거', message: 'fiche를 제거할까요?',
      detail: dir, checkboxLabel: '사용 기록과 설정도 지우기', checkboxChecked: false,
      buttons: ['제거', '취소'], defaultId: 0, cancelId: 1, noLink: true,
    });
    if (r.response !== 0) return app.exit(0);
    wipe = r.checkboxChecked;
  } else wipe = process.env.FICHE_UNINSTALL_YES === 'wipe';

  // A running copy gets our argv through 'second-instance' and quits (restoring Claude Code settings).
  if (!app.requestSingleInstanceLock()) for (let i = 0; i < 20; i++) { await sleep(500); if (app.requestSingleInstanceLock()) break; }
  try { // in case the app was not running or was killed: put settings.json back
    const claude = require('./claude');
    const cfg = JSON.parse(ofs.readFileSync(path.join(app.getPath('userData'), 'config.json'), 'utf8'));
    claude.disconnect(`http://127.0.0.1:${require('./proxy').PORT}`, cfg.upstream);
  } catch { }
  try { app.setLoginItemSettings({ openAtLogin: false, args: ['--hidden'] }); } catch { }
  shortcut(desktopLnk(), dir, false);
  shortcut(startMenuLnk(), dir, false);
  await reg(['delete', KEY, '/f']);

  // Delete the folder after this process exits.
  const targets = [dir].concat(wipe ? [app.getPath('userData')] : []);
  const cmd = 'ping 127.0.0.1 -n 3 > nul & ' + targets.map(t => `rmdir /s /q "${t}"`).join(' & ');
  spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/c', cmd], { cwd: os.tmpdir(), detached: true, stdio: 'ignore', windowsHide: true }).unref();
  app.exit(0);
}

// Called first thing in main.js. Returns true when this process is one of the special modes.
function handles() {
  const argv = process.argv;
  if (argv.includes('--quit')) { app.requestSingleInstanceLock(); app.quit(); return true; }
  if (process.platform !== 'win32') return false;
  if (argv.includes('--uninstall')) { runUninstall(); return true; }
  if (process.env.PORTABLE_EXECUTABLE_FILE) { runSetup(); return true; }
  return false;
}

module.exports = { handles };
