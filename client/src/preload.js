// Bridge between the UI (../ui, edited by hand) and the main process. The UI's own scripts keep
// working as before; this file only adds the real behaviour behind a few existing controls.
const { contextBridge, ipcRenderer } = require('electron');

const api = {
  win: action => ipcRenderer.invoke('win', action),
  status: () => ipcRenderer.invoke('status'),
  setProxy: on => ipcRenderer.invoke('proxy:set', on),
  setClaude: on => ipcRenderer.invoke('claude:set', on),
  setAutostart: on => ipcRenderer.invoke('autostart:set', on),
  setSignals: on => ipcRenderer.invoke('signals:set', on),
  signIn: () => ipcRenderer.invoke('account:signin'),
  stats: () => ipcRenderer.invoke('stats:get'),
  netlog: () => ipcRenderer.invoke('netlog:get'),
  onNetlog: cb => ipcRenderer.on('netlog:update', (_e, r) => cb(r)),
  onStats: cb => ipcRenderer.on('stats:update', (_e, r) => cb(r)),
  signOut: () => ipcRenderer.invoke('account:signout'),
  openExternal: url => ipcRenderer.invoke('open:external', url),
};
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
}

window.addEventListener('DOMContentLoaded', async () => {
  document.body.classList.remove('framed'); // the app window is the frame
  const s = await api.status();
  const q = sel => document.querySelector(sel);
  bind(q('#proxyToggle'), s.proxyOn, async on => (await api.setProxy(on)).proxyOn);
  bind(q('[aria-label="Claude Code 연결"]'), s.connected, async on => (await api.setClaude(on)).connected);
  bind(q('[aria-label="자동 실행"]'), s.autostart, async on => (await api.setAutostart(on)).autostart);
  bind(q('[aria-label="사용 통계 보내기"]'), s.shareSignals, async on => (await api.setSignals(on)).shareSignals);
  // 11-17: the 로그인 row in settings. Signed out the app still works (anonymous install ID).
  const row = [...document.querySelectorAll('.item')].find(i => i.querySelector('b')?.textContent.trim() === '로그인');
  if (row) {
    const label = row.querySelector('span'), btn = row.querySelector('button');
    const paint = a => {
      label.textContent = a?.signedIn ? (a.email || 'GitHub 계정으로 로그인되어 있어요.') : '로그인은 선택 사항이에요. 브라우저에서 GitHub 기기 코드로 승인해요.';
      btn.textContent = a?.signedIn ? '로그아웃' : 'GitHub로 로그인';
      btn.classList.toggle('danger', !!a?.signedIn);
    { const kh = document.getElementById('keyHint'); if (kh) kh.value = a?.keyHint || ''; }
    };
    paint(s.account);
    btn.addEventListener('click', async () => {
      if (btn.disabled) return;
      btn.disabled = true;
      const signedIn = btn.textContent === '로그아웃';
      if (!signedIn) label.textContent = '브라우저 승인 대기 중';
      try { paint((await (signedIn ? api.signOut() : api.signIn())).account); }
      catch (e) { label.textContent = String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''); }
      finally { btn.disabled = false; }
    });
  }
});
