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
const stats = { requests: 0, compressed: 0, passthrough: 0, errors: 0, lastError: null };

function createProxy(getConfig, getInfo = async () => ({})) {
  const srv = http.createServer(async (req, res) => {
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
      const out = await engine.compress(body);
      if (out) { body = out; stats.compressed++; } else stats.passthrough++;
    } else stats.passthrough++;

    const up = new URL(cfg.upstream || 'https://api.anthropic.com');
    const basePath = up.pathname.replace(/\/$/, '');
    const headers = { ...req.headers, host: up.host, 'content-length': body.length };
    delete headers.connection;
    const lib = up.protocol === 'http:' ? http : https;
    const out = lib.request({
      protocol: up.protocol, hostname: up.hostname, port: up.port || undefined,
      method: req.method, path: basePath + req.url, headers,
    }, upRes => {
      try { net.upstream({ host: up.hostname, path: basePath + req.url.split('?')[0], bytesIn: origLen, bytesOut: body.length, status: upRes.statusCode, ms: Date.now() - t0, compressed: body.length !== origLen }); } catch { }
      res.writeHead(upRes.statusCode, upRes.headers); upRes.pipe(res);
    });
    out.on('error', e => {
      stats.errors++; stats.lastError = String(e.message || e);
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'fiche proxy: ' + stats.lastError } }));
    });
    out.end(body);
  });
  srv.requestTimeout = 0; srv.headersTimeout = 0; // long streaming turns
  return {
    stats,
    listen: () => new Promise((ok, fail) => { srv.once('error', fail); srv.listen(PORT, '127.0.0.1', () => ok(PORT)); }),
    close: () => new Promise(ok => srv.close(() => ok())),
  };
}

module.exports = { createProxy, PORT };
