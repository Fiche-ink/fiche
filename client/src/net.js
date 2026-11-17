// Every byte the fiche PC app sends over the network goes through this file (open-source client).
// The bundled engine has no network code of its own: the app hands it `request` via setNet(), and
// the local proxy reports each upstream (Anthropic) call here too. The app's "보낸 기록" screen
// shows this log, so users can see exactly where data went and what the fiche servers received.
//
// Destinations: api.anthropic.com (your own Claude Code requests, compressed),
// judge.fiche.ink (per-block numbers, outcome signals), api.fiche.ink (sign-in only).
const { EventEmitter } = require('events');

const MAX = 300;
const log = [];
const emitter = new EventEmitter();


// Plain Node https client instead of fetch: every byte fiche sends goes through https.globalAgent, so
// SSLKEYLOGFILE (below) covers the judge, signals, sign-in and the forwarded Claude requests alike.
const http = require('http'), https = require('https'), fs = require('fs');
if (process.env.SSLKEYLOGFILE) {
  // Same format browsers write, so Wireshark can decrypt a capture of this app's traffic.
  https.globalAgent.on('keylog', line => { try { fs.appendFileSync(process.env.SSLKEYLOGFILE, line); } catch { } });
}
function httpsFetch(url, opts = {}) {
  return new Promise((ok, fail) => {
    const u = new URL(url), lib = u.protocol === 'http:' ? http : https;
    const body = opts.body == null ? null : Buffer.isBuffer(opts.body) ? opts.body : Buffer.from(String(opts.body));
    const headers = { ...(opts.headers || {}) };
    if (body) headers['content-length'] = body.length;
    const req = lib.request(u, { method: opts.method || 'GET', headers }, res => {
      const parts = [];
      res.on('data', c => parts.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(parts);
        ok({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode,
          text: async () => buf.toString('utf8'), json: async () => JSON.parse(buf.toString('utf8')) });
      });
      res.on('error', fail);
    });
    req.on('error', fail);
    const sig = opts.signal;
    if (sig) {
      if (sig.aborted) return req.destroy(new Error('aborted'));
      sig.addEventListener('abort', () => req.destroy(new Error('timeout')), { once: true });
    }
    req.end(body || undefined);
  });
}

function add(entry) {
  const e = { at: Date.now(), ...entry };
  log.unshift(e); if (log.length > MAX) log.pop();
  emitter.emit('sent', e);
  return e;
}

// What the fiche servers received, in full: these bodies are numbers, labels and salted hashes only.
function bodyOf(opts) {
  const b = opts?.body;
  if (typeof b !== 'string') return null;
  try { const j = JSON.parse(b); if (j && j.device_code) j.device_code = '…'; return j; } catch { return b.slice(0, 2000); }
}

// fetch wrapper used by the engine (judge, signals) and the sign-in code.
async function request(url, opts = {}) {
  const u = new URL(url), t0 = Date.now();
  const entry = { kind: u.pathname.startsWith('/v1/signals') ? 'signals' : u.pathname.startsWith('/v1/judge') ? 'judge' : 'account',
    host: u.host, path: u.pathname, method: opts.method || 'GET',
    bytes: typeof opts.body === 'string' ? Buffer.byteLength(opts.body) : 0, body: bodyOf(opts) };
  try {
    const res = await httpsFetch(url, opts);
    add({ ...entry, status: res.status, ms: Date.now() - t0 });
    return res;
  } catch (e) {
    add({ ...entry, status: 0, error: String(e?.message || e).slice(0, 200), ms: Date.now() - t0 });
    throw e;
  }
}

// Called by the proxy for each Claude Code request it forwards. The conversation itself is not
// copied into the log (it is your own data going to Anthropic); only sizes and the result.
function upstream({ host, path, bytesIn, bytesOut, status, ms, compressed }) {
  return add({ kind: 'anthropic', host, path, method: 'POST', bytes: bytesOut, bytesOriginal: bytesIn, status, ms, compressed: !!compressed });
}

module.exports = { request, upstream, list: () => log.slice(), on: (ev, f) => emitter.on(ev, f) };
