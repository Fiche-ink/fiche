// Bridge between the UI (../ui, edited by hand) and the main process. The UI's own scripts keep
// working as before; this file only adds the real behaviour behind a few existing controls.
const { contextBridge, ipcRenderer } = require('electron');

const api = {
  lang: ipcRenderer.sendSync('lang:get'),
  setLang: l => ipcRenderer.invoke('lang:set', l),
  win: action => ipcRenderer.invoke('win', action),
  status: () => ipcRenderer.invoke('status'),
  setProxy: on => ipcRenderer.invoke('proxy:set', on),
  setClaude: on => ipcRenderer.invoke('claude:set', on),
  setAutostart: on => ipcRenderer.invoke('autostart:set', on),
  setContrib: on => ipcRenderer.invoke('contrib:set', on),
  setPlan: plan => ipcRenderer.invoke('plan:set', plan),
  signIn: () => ipcRenderer.invoke('account:signin'),
  cancelSignIn: () => ipcRenderer.invoke('account:cancel'),
  signOut: () => ipcRenderer.invoke('account:signout'),
  refreshAccount: () => ipcRenderer.invoke('account:refresh'),
  onAccount: cb => ipcRenderer.on('account:update', (_e, a) => cb(a)),
  stats: () => ipcRenderer.invoke('stats:get'),
  netlog: () => ipcRenderer.invoke('netlog:get'),
  onNetlog: cb => ipcRenderer.on('netlog:update', (_e, r) => cb(r)),
  onStats: cb => ipcRenderer.on('stats:update', (_e, r) => cb(r)),
  openExternal: url => ipcRenderer.invoke('open:external', url),
  onClaude: cb => ipcRenderer.on('claude:update', (_e, on) => cb(on)),
};
const L = (ko, en) => api.lang === 'en' ? en : ko;
contextBridge.exposeInMainWorld('fiche', api);

// Wire a UI switch to a main-process setting: match the real state first, then follow clicks.
// `set(on)` returns the state that actually took effect; if it differs, the switch flips back.
function bind(el, real, set) {
  if (!el) return;
  if (el.classList.contains('on') !== !!real) el.click(); // the UI's own handler updates its label
  let syncing = false;
  el.addEventListener('click', async () => {
    if (syncing) return;
    const want = el.classList.contains('on');
    const got = await set(want);
    if (got !== want) { syncing = true; el.click(); syncing = false; }
  });
  el._fsync = v => { if (el.classList.contains('on') !== !!v) { syncing = true; el.click(); syncing = false; } };
}

window.addEventListener('DOMContentLoaded', async () => {
  document.body.classList.remove('framed'); // the app window is the frame
  const s = await api.status();
  { const v = [...document.querySelectorAll('.item')].find(i => i.querySelector('b')?.textContent.trim() === (api.lang === 'en' ? 'Version' : '버전')); const m = v?.querySelector('.mono'); if (m) m.textContent = s.version; }
  // ui/i18n.js keeps the Korean label in data-ko-aria-label when it shows English, so match either.
  const q = sel => document.querySelector(sel.replace(/\[aria-label="([^"]*)"\]/g, (m, v) => `:is([data-ko-aria-label="${v}"],[aria-label="${v}"])`));
  bind(q('#proxyToggle'), s.proxyOn, async on => (await api.setProxy(on)).proxyOn);
  const ccSw = q('[aria-label="Claude Code 연결"]');
  const ccDetails = ccSw?.closest('.feature')?.querySelector('.details');
  const ccText = st => st.connected ? L('settings.json에 연결돼 있습니다. fiche를 끄면 원래대로 돌아갑니다.', 'Connected through settings.json. Turning fiche off restores the original.')
    : !st.autoConnect ? L('꺼 두었습니다. 켜면 다시 연결합니다.', 'Turned off. Turn it on to connect again.')
    : !st.claudeFound ? L('Claude Code를 찾지 못했습니다. 설치하면 자동으로 연결됩니다.', 'Claude Code was not found. It connects automatically once installed.') : null;
  const ccPaint = st => { const t = ccText(st); if (ccDetails && t) ccDetails.textContent = t; };
  ccPaint(s);
  bind(ccSw, s.connected, async on => { const r = await api.setClaude(on); ccPaint(r); return r.connected; });
  api.onClaude(async on => { ccSw?._fsync?.(on); ccPaint(await api.status()); });
  bind(q('[aria-label="자동 실행"]'), s.autostart, async on => (await api.setAutostart(on)).autostart);
  bind(q('[aria-label="데이터 기여"]'), s.contrib, async on => (await api.setContrib(on)).contrib);
});
