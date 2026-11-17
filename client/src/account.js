const net = require('./net');
// fiche account sign-in for the PC app (11-17), using the device flow on api.fiche.ink:
//   POST /auth/device {name} -> { device_code, verification_uri_complete, interval, expires_in }
//   the browser opens the approve page (GitHub sign-in there), the app polls
//   POST /auth/device/token {device_code} until it returns { key }.
// The key (fk_...) is kept in the app's config and sent to the judge instead of the anonymous
// install token, so judge numbers and the early-tester counts land on the account.
const API = process.env.FICHE_API || 'https://api.fiche.ink';

let pending = null;

async function post(path, body) {
  const r = await net.request(API + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}), signal: AbortSignal.timeout(15000) });
  let j = null; try { j = await r.json(); } catch { }
  return { ok: r.ok, status: r.status, body: j || {} };
}

// Starts sign-in and resolves with the API key, or throws. openUrl opens the approve page.
async function signIn(openUrl) {
  if (pending) return pending;
  pending = (async () => {
    const s = await post('/auth/device', { name: 'fiche PC app' });
    if (!s.ok || !s.body.device_code) throw new Error('로그인을 시작하지 못했어요 (' + s.status + ')');
    await openUrl(s.body.verification_uri_complete || s.body.verification_uri);
    let wait = Math.max(3, +s.body.interval || 5) * 1000;
    const until = Date.now() + Math.min(900, +s.body.expires_in || 600) * 1000;
    while (Date.now() < until) {
      await new Promise(r => setTimeout(r, wait));
      const t = await post('/auth/device/token', { device_code: s.body.device_code });
      if (t.ok && typeof t.body.key === 'string') return t.body.key;
      const err = t.body.error || t.body.message || '';
      if (/slow_down/.test(err)) wait += 5000;
      else if (/authorization_pending/.test(err)) continue;
      else throw new Error(/denied/.test(err) ? '로그인이 거부됐어요' : /expired/.test(err) ? '로그인 시간이 지났어요' : '로그인 실패: ' + (err || t.status));
    }
    throw new Error('로그인 시간이 지났어요');
  })();
  try { return await pending; } finally { pending = null; }
}

// Who the key belongs to (for the settings line). null when signed out or the key stopped working.
async function me(key) {
  if (!key) return null;
  try {
    const r = await net.request(API + '/v1/me', { headers: { authorization: 'Bearer ' + key }, signal: AbortSignal.timeout(10000) });
    if (!r.ok) return r.status === 401 ? { invalid: true } : null;
    const j = await r.json();
    return { email: j.email || null, providers: j.sign_in || [] };
  } catch { return null; }
}

module.exports = { API, signIn, me };
