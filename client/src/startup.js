// "Start with Windows". Installed from MSIX, the Run registry key is virtualized and ignored, so the
// package's StartupTask (TaskId ficheStartup, build/appx-extensions.xml) is used instead, through
// resources/fiche-startup.exe (helper/), which gets the package identity because it ships inside the
// package. Other installs use login items.
const { app } = require('electron');
const { execFile } = require('child_process');
const path = require('path');

const isStore = !!process.windowsStore;

function helper(action) {
  const exe = path.join(process.resourcesPath, 'fiche-startup.exe');
  return new Promise(ok => execFile(exe, [action], { windowsHide: true, timeout: 15000 },
    (err, out, errOut) => ok(err ? { error: (String(errOut || '').trim() || String(err.message || err)).slice(0, 200) } : { state: out.trim() })));
}

// Returns { on, state, error }. state is the StartupTask state (Enabled, Disabled, DisabledByUser, ...).
async function get() {
  if (!isStore) return { on: app.getLoginItemSettings().openAtLogin };
  const r = await helper('get');
  return { on: /^Enabled/.test(r.state || ''), ...r };
}
async function set(on) {
  if (!isStore) { app.setLoginItemSettings({ openAtLogin: on, args: ['--hidden'] }); return get(); }
  const r = await helper(on ? 'on' : 'off');
  return { on: /^Enabled/.test(r.state || ''), ...r };
}

module.exports = { isStore, get, set };
