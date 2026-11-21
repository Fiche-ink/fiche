// window.fiche for the CLI's app screen (served by cli/ui.js): the same API and switch wiring as
// the Windows app's src/preload.js, over fetch and server-sent events instead of Electron IPC.
(() => {
  const call = async (method, arg) => {
    const r = await fetch('/api/' + encodeURIComponent(method), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ arg }),
    });
    if (r.status === 401) { location.reload(); throw new Error('signed out of the screen'); }
    const out = await r.json();
    if (!r.ok) throw new Error(out?.error || r.statusText);
    return out;
  };

  const listeners = {};
  const on = name => cb => { (listeners[name] ||= []).push(cb); };
  const es = new EventSource('/api/events');
  for (const name of ['account:update', 'netlog:update', 'stats:update', 'claude:update']) {
    es.addEventListener(name, e => { let d = null; try { d = JSON.parse(e.data); } catch { } for (const cb of listeners[name] || []) { try { cb(d); } catch (err) { console.error(err); } } });
  }

  const api = {
    lang: window.__ficheLang === 'en' ? 'en' : 'ko',
    setLang: async l => { const r = await call('lang:set', l); location.reload(); return r; },
    win: () => Promise.resolve(),
    status: () => call('status'),
    setProxy: v => call('proxy:set', v),
    setClaude: v => call('claude:set', v),
    setAutostart: v => call('autostart:set', v),
    setContrib: v => call('contrib:set', v),
    setPlan: plan => call('plan:set', plan),
    signIn: () => call('account:signin'),
    cancelSignIn: () => call('account:cancel'),
    signOut: () => call('account:signout'),
    refreshAccount: () => call('account:refresh'),
    onAccount: on('account:update'),
    stats: () => call('stats:get'),
    latestPage: () => call('page:latest'),
    netlog: () => call('netlog:get'),
    onNetlog: on('netlog:update'),
    onStats: on('stats:update'),
    openExternal: url => call('open:external', url),
    onClaude: on('claude:update'),
  };
  const L = (ko, en) => api.lang === 'en' ? en : ko;
  Object.defineProperty(window, 'fiche', { value: Object.freeze(api), writable: false });

  // Links leave the app screen for the real browser, as in the Windows app.
  document.addEventListener('click', e => {
    const a = e.target.closest?.('a[href]');
    if (!a || !/^https?:/i.test(a.href) || new URL(a.href).origin === location.origin) return;
    e.preventDefault();
    if (/^https:/i.test(a.href)) api.openExternal(a.href);
  }, true);

  function bind(el, real, set) {
    if (!el) return;
    if (el.classList.contains('on') !== !!real) el.click();
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
    document.body.classList.remove('framed');
    const s = await api.status();
    { const v = [...document.querySelectorAll('.item')].find(i => i.querySelector('b')?.textContent.trim() === (api.lang === 'en' ? 'Version' : '버전')); const m = v?.querySelector('.mono'); if (m) m.textContent = s.version; }
    const q = sel => document.querySelector(sel.replace(/\[aria-label="([^"]*)"\]/g, (m, v) => `:is([data-ko-aria-label="${v}"],[aria-label="${v}"])`));
    bind(q('#proxyToggle'), s.proxyOn, async v => (await api.setProxy(v)).proxyOn);
    const ccSw = q('[aria-label="Claude Code 연결"]');
    const ccDetails = ccSw?.closest('.feature')?.querySelector('.details');
    const ccText = st => st.connected ? L('settings.json에 연결돼 있습니다. fiche를 끄면 원래대로 돌아갑니다.', 'Connected through settings.json. Turning fiche off restores the original.')
      : !st.autoConnect ? L('꺼 두었습니다. 켜면 다시 연결합니다.', 'Turned off. Turn it on to connect again.')
      : !st.claudeFound ? L('Claude Code를 찾지 못했습니다. 설치하면 자동으로 연결됩니다.', 'Claude Code was not found. It connects automatically once installed.') : null;
    const ccPaint = st => { const t = ccText(st); if (ccDetails && t) ccDetails.textContent = t; };
    ccPaint(s);
    bind(ccSw, s.connected, async v => { const r = await api.setClaude(v); ccPaint(r); return r.connected; });
    api.onClaude(async v => { ccSw?._fsync?.(v); ccPaint(await api.status()); });
    bind(q('[aria-label="자동 실행"]'), s.autostart, async v => (await api.setAutostart(v)).autostart);
    bind(q('[aria-label="데이터 기여"]'), s.contrib, async v => (await api.setContrib(v)).contrib);
  });
})();
