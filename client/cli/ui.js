// The app screen for the CLI: desktop/ui served on 127.0.0.1, shown by the fiche window app
// (shell/, Tauri) or a browser. ui/ talks to the daemon through window.fiche, the same API the
// Windows app's preload.js gives it; here that API is bridge.js over fetch and server-sent events.
//
// Any program on this machine can reach a loopback port, and any web page can make the
// browser send requests to one, so every request needs the token from ui.json (0600, readable
// only by this user): once as ?t= in the address, then as an HttpOnly SameSite=Strict cookie.
// The Host header must be our own address (DNS rebinding) and API calls must come from our own
// origin.
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const P = require('./paths');

const FILE = path.join(P.dataDir, 'ui.json');
const PREFERRED_PORT = 47322;
const DIR = path.join(P.root(), 'ui');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json',
};

let conf = null, srv = null, clients = new Set();

function loadConf() {
  try {
    const c = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (/^[0-9a-f]{64}$/.test(c.token) && Number.isInteger(c.port)) return c;
  } catch { }
  return { port: PREFERRED_PORT, token: crypto.randomBytes(32).toString('hex') };
}
function saveConf() {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(conf) + '\n', { mode: 0o600 });
  try { fs.chmodSync(FILE, 0o600); } catch { }
}

const url = () => conf && `http://127.0.0.1:${conf.port}/?t=${conf.token}`;
const cookieName = () => `fiche_ui_${conf.port}`;
const same = (a, b) => typeof a === 'string' && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

function cookie(req) {
  const m = new RegExp(`(?:^|;\\s*)${cookieName()}=([0-9a-f]{64})`).exec(req.headers.cookie || '');
  return m ? m[1] : null;
}

function send(res, code, body, type = 'text/plain; charset=utf-8', extra = {}) {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', ...extra });
  res.end(body);
}

// index.html as the Windows app loads it, plus bridge.js (window.fiche) and shell.css.
function indexHtml() {
  let html = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8');
  html = html.replace('</head>', '<link rel="stylesheet" href="shell.css">\n</head>');
  html = html.replace(/(<script src="i18n\.js">)/, '<script src="bridge.js"></script>\n$1');
  return html;
}

// Fills the window instead of drawing the 1040x680 mock frame; the window app has real title
// bar buttons, so the UI's own min/max/close are hidden.
const SHELL_CSS = 'html, body { margin: 0; height: 100%; overflow: hidden; } .win { width: 100vw !important; height: 100vh !important; border-radius: 0 !important; box-shadow: none !important; } .win-ctrls { display: none !important; }\n';

function serveStatic(req, res, rel) {
  const file = path.resolve(DIR, '.' + path.posix.normalize('/' + rel));
  if (!file.startsWith(DIR + path.sep)) return send(res, 404, 'not found');
  if (/\.bak/.test(file) || path.basename(file) === 'setup.html' || path.basename(file) === 'setup.js') return send(res, 404, 'not found');
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'not found');
    send(res, 200, buf, TYPES[path.extname(file)] || 'application/octet-stream');
  });
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((ok, fail) => {
    let size = 0; const parts = [];
    req.on('data', d => { size += d.length; if (size > limit) { fail(new Error('too large')); req.destroy(); } else parts.push(d); });
    req.on('end', () => ok(Buffer.concat(parts).toString('utf8')));
    req.on('error', fail);
  });
}

function events(req, res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write('retry: 2000\n\n');
  const c = { res, at: Date.now() };
  clients.add(c);
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { } }, 25000);
  req.on('close', () => { clearInterval(ping); clients.delete(c); });
}

function broadcast(name, data) {
  const msg = `event: ${name}\ndata: ${JSON.stringify(data === undefined ? null : data)}\n\n`;
  for (const c of clients) { try { c.res.write(msg); } catch { } }
}

// call(method, arg) -> result: the daemon's side of window.fiche. lang() -> 'ko' | 'en'.
function listen({ call, lang, log = () => { } }) {
  conf = loadConf();
  const handler = async (req, res) => {
    const host = req.headers.host || '';
    if (host !== `127.0.0.1:${conf.port}` && host !== `localhost:${conf.port}`) return send(res, 403, 'forbidden');
    const u = new URL(req.url, `http://${host}`);

    // ?t=<token> once, then the cookie; the token leaves the address bar right away.
    const t = u.searchParams.get('t');
    if (t !== null) {
      if (!same(t, conf.token)) return send(res, 403, 'forbidden');
      u.searchParams.delete('t');
      return send(res, 302, '', undefined, {
        'Set-Cookie': `${cookieName()}=${conf.token}; Path=/; HttpOnly; SameSite=Strict`,
        'Location': u.pathname + (u.search || ''),
      });
    }
    if (!same(cookie(req) || '', conf.token)) {
      return send(res, 401, lang() === 'en' ? 'Open this screen with: fiche ui' : '이 화면은 fiche ui 명령으로 여세요.');
    }

    if (u.pathname.startsWith('/api/')) {
      const origin = req.headers.origin;
      if (origin && origin !== `http://${host}`) return send(res, 403, 'forbidden');
      if (u.pathname === '/api/events' && req.method === 'GET') return events(req, res);
      if (req.method !== 'POST' || !/^application\/json\b/.test(req.headers['content-type'] || '')) return send(res, 405, 'method not allowed');
      let arg;
      try { arg = JSON.parse((await readBody(req)) || '{}').arg; } catch { return send(res, 400, 'bad request'); }
      const method = decodeURIComponent(u.pathname.slice(5));
      try {
        const out = await call(method, arg);
        return send(res, 200, JSON.stringify(out === undefined ? null : out), 'application/json');
      } catch (e) {
        return send(res, e.code === 'EUNKNOWN' ? 404 : 500, JSON.stringify({ error: String(e?.message || e) }), 'application/json');
      }
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'method not allowed');
    if (u.pathname === '/' || u.pathname === '/index.html') return send(res, 200, indexHtml(), TYPES['.html']);
    if (u.pathname === '/bridge.js') return send(res, 200, `window.__ficheLang = ${JSON.stringify(lang())};\n` + fs.readFileSync(path.join(__dirname, 'bridge.js'), 'utf8'), TYPES['.js']);
    if (u.pathname === '/shell.css') return send(res, 200, SHELL_CSS, TYPES['.css']);
    return serveStatic(req, res, u.pathname);
  };

  const tryPort = port => new Promise((ok, fail) => {
    const s = http.createServer((req, res) => handler(req, res).catch(e => { log('ui:', e?.message || e); try { send(res, 500, 'error'); } catch { } }));
    s.once('error', fail);
    s.listen(port, '127.0.0.1', () => ok(s));
  });
  return tryPort(conf.port)
    .catch(e => { if (e.code !== 'EADDRINUSE') throw e; return tryPort(0); })
    .then(s => { srv = s; conf.port = s.address().port; saveConf(); return url(); });
}

function close() { for (const c of clients) { try { c.res.end(); } catch { } } clients.clear(); try { srv?.close(); } catch { } }

module.exports = { listen, close, broadcast, url, viewers: () => clients.size, FILE };
