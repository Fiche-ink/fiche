// Local proxy for Claude Code on 127.0.0.1:47321.
// Each /v1/messages request is compressed on this PC by the bundled engine (src/engine.js); the fiche
// server only answers per-block questions with numbers. If the engine fails or skips a request, the
// original body is sent upstream unchanged, so Claude Code keeps working. With the proxy switch off,
// nothing is touched at all.
const http = require('http'), https = require('https');
const server = require('./server');
const engine = require('./engine');
const net = require('./net');

const PORT = 47321;
// Spares for when another program holds PORT; 47322 is the window UI. claude.js FICHE_URL must match.
const PORTS = [PORT, 47331, 47332, 47333, 47334, 47335, 47336, 47337, 47338, 47339];
const stats = { requests: 0, compressed: 0, passthrough: 0, errors: 0, lastError: null };
// Claude's own limit readings from the response headers (anthropic-ratelimit-unified-*: 7d/5h
// utilization, reset times). Only plain numbers are kept, under whatever names the headers use, so
// a renamed or new header changes the report instead of breaking it (carbon 7.8).
const LIMIT_PREFIX = 'anthropic-ratelimit-unified-';
let limits = {}, limitsAt = 0;
function readLimits(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    if (!k.startsWith(LIMIT_PREFIX)) continue;
    const n = Number(Array.isArray(v) ? v[0] : v);
    if (Number.isFinite(n) && Object.keys(out).length < 16) out[k.slice(LIMIT_PREFIX.length).slice(0, 32)] = n;
  }
  if (Object.keys(out).length) { limits = out; limitsAt = Date.now(); }
}

function createProxy(getConfig, getInfo = async () => ({})) {
  let port = PORT;
  // An exception here would leave Claude Code waiting on a request that never answers.
  const srv = http.createServer((req, res) => handle(req, res).catch(e => {
    stats.errors++; stats.lastError = String(e?.message || e);
    if (res.headersSent) { res.destroy(); return; }
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'fiche proxy: ' + stats.lastError } }));
  }));
  async function handle(req, res) {
    if (req.url.split('?')[0] === '/fiche/health') {
      const full = req.url.includes('full=1') ? await getInfo() : {};
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, stats, server: server.lastStatus(), ...full }));
    }
    const chunks = [];
    for await (const c of req) chunks.push(c);
    let body = Buffer.concat(chunks);
    const origLen = body.length, t0 = Date.now();
    stats.requests++;

    const cfg = getConfig();
    if (cfg.proxyOn && req.method === 'POST' && req.url.split('?')[0] === '/v1/messages') {
      // 11-17: compress on this PC with the bundled v0 engine; the server only sees numbers.
      let out = null;
      try { out = await engine.compress(body); } catch (e) { stats.lastError = 'compress: ' + (e?.message || e); }
      if (out) { body = out; stats.compressed++; } else stats.passthrough++;
    } else stats.passthrough++;

    const up = new URL(cfg.upstream || 'https://api.anthropic.com');
    const basePath = up.pathname.replace(/\/$/, '');
    const headers = { ...req.headers, host: up.host, 'content-length': body.length };
    delete headers.connection; delete headers['transfer-encoding'];
    const lib = up.protocol === 'http:' ? http : https;
    const out = lib.request({
      protocol: up.protocol, hostname: up.hostname, port: up.port || undefined,
      method: req.method, path: basePath + req.url, headers,
    }, upRes => {
      try { net.upstream({ host: up.hostname, path: basePath + req.url.split('?')[0], bytesIn: origLen, bytesOut: body.length, status: upRes.statusCode, ms: Date.now() - t0, compressed: body.length !== origLen }); } catch { }
      readLimits(upRes.headers); res.writeHead(upRes.statusCode, upRes.headers);
      upRes.on('error', () => res.destroy());
      upRes.pipe(res);
    });
    // Claude Code cancelled (Esc) or went away: stop the upstream request so it stops generating.
    res.on('close', () => { if (!res.writableFinished) out.destroy(); });
    out.on('error', e => {
      if (res.destroyed) return; // cancelled by the client above
      stats.errors++; stats.lastError = String(e.message || e);
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'fiche proxy: ' + stats.lastError } }));
    });
    out.end(body);
  }
  srv.requestTimeout = 0; srv.headersTimeout = 0; // long streaming turns
  return {
    stats,
    limits: () => (limitsAt && Date.now() - limitsAt < 7 * 864e5 ? { ...limits, age_s: Math.round((Date.now() - limitsAt) / 1000) } : {}),
    // Tries the last port used first so a running Claude Code keeps its address across restarts.
    listen: async (prefer) => {
      for (const p of new Set([prefer, ...PORTS].filter(x => PORTS.includes(x)))) {
        try {
          await new Promise((ok, fail) => { srv.once('error', fail); srv.listen(p, '127.0.0.1', () => { srv.off('error', fail); ok(); }); });
          return (port = p);
        } catch (e) { if (e.code !== 'EADDRINUSE') throw e; }
      }
      throw Object.assign(new Error(`ports ${PORTS[0]}-${PORTS.at(-1)} are all in use`), { code: 'EADDRINUSE' });
    },
    port: () => port,
    // Open streams would keep close() waiting and the port taken; a restart needs it free now.
    close: () => new Promise(ok => { srv.close(() => ok()); srv.closeAllConnections?.(); }),
  };
}

module.exports = { createProxy, PORT, PORTS };
