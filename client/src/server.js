// fiche server client. The real endpoints (POST /v1/render, account, usage) are not live yet,
// so every call answers 404 without touching the network. Swap `request` for a real fetch later.
const BASE = process.env.FICHE_API || 'https://api.fiche.ink';

let last = { status: null, at: null, path: null };

async function request(method, path /* , body */) {
  last = { status: 404, at: new Date().toISOString(), path: `${method} ${path}` };
  return { ok: false, status: 404, body: { error: 'not_found', message: 'fiche server is not live yet' } };
}

module.exports = {
  BASE,
  render: payload => request('POST', '/v1/render', payload),
  account: () => request('GET', '/v1/account'),
  usage: () => request('GET', '/v1/usage'),
  lastStatus: () => last,
};
