// HTTPS_PROXY mode. Claude Desktop's Code tab starts Claude Code with ANTHROPIC_BASE_URL set to
// https://api.anthropic.com, which skips the base-URL connection, but it still reads HTTPS_PROXY and
// NODE_EXTRA_CA_CERTS from ~/.claude/settings.json. So the proxy also answers CONNECT: api.anthropic.com
// is opened here with a certificate from a local CA and handled like any other request; every other host
// is tunnelled untouched (through the proxy Claude Code had before, if any).
// The CA is made on this PC, its key never leaves the data folder, and a name constraint limits it to
// api.anthropic.com, so even a leaked key cannot vouch for any other site.
const fs = require('fs'), path = require('path'), crypto = require('crypto'), tls = require('tls'), net = require('net');

// ---- minimal DER / X.509 writer (Node has no certificate builder) ----
const len = n => { if (n < 128) return Buffer.from([n]); const b = []; for (; n; n = Math.floor(n / 256)) b.unshift(n & 255); return Buffer.from([0x80 | b.length, ...b]); };
const tlv = (tag, ...parts) => { const v = Buffer.concat(parts); return Buffer.concat([Buffer.from([tag]), len(v.length), v]); };
const seq = (...p) => tlv(0x30, ...p), set = (...p) => tlv(0x31, ...p);
const int = b => tlv(0x02, b[0] & 0x80 ? Buffer.concat([Buffer.from([0]), b]) : b);
const oid = s => {
  const [a, b, ...r] = s.split('.').map(Number), out = [40 * a + b];
  for (const n of r) { const t = []; let x = n; do { t.unshift(x & 0x7f); x >>= 7; } while (x); out.push(...t.map((v, i) => i < t.length - 1 ? v | 0x80 : v)); }
  return tlv(0x06, Buffer.from(out));
};
const utf8 = s => tlv(0x0c, Buffer.from(s, 'utf8'));
const time = d => { const s = d.toISOString().replace(/[-:T]/g, '').slice(0, 14) + 'Z'; return d.getUTCFullYear() < 2050 ? tlv(0x17, Buffer.from(s.slice(2))) : tlv(0x18, Buffer.from(s)); };
const bits = (b, unused = 0) => tlv(0x03, Buffer.from([unused]), b);
const oct = b => tlv(0x04, b);
const bool = v => tlv(0x01, Buffer.from([v ? 0xff : 0]));
const ext = (id, critical, der) => seq(oid(id), ...(critical ? [bool(true)] : []), oct(der));
const name = cn => seq(set(seq(oid('2.5.4.3'), utf8(cn))), set(seq(oid('2.5.4.10'), utf8('fiche'))));
const ECDSA_SHA256 = seq(oid('1.2.840.10045.4.3.2'));
const dns = h => tlv(0x82, Buffer.from(h, 'ascii'));
const pem = (der, label) => `-----BEGIN ${label}-----\n${der.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END ${label}-----\n`;
const ski = pub => crypto.createHash('sha1').update(pub.export({ type: 'spki', format: 'der' }).subarray(-65)).digest();

// opts: { cn, pub, issuerName, issuerKey, issuerSki, ca, hosts, permit, days }
function makeCert(o) {
  const now = Date.now(), serial = crypto.randomBytes(16); serial[0] &= 0x7f;
  const exts = o.ca
    ? [ext('2.5.29.19', true, seq(bool(true), int(Buffer.from([0])))), ext('2.5.29.15', true, bits(Buffer.from([0x86]), 1)), ext('2.5.29.14', false, oct(ski(o.pub))),
      ...(o.permit ? [ext('2.5.29.30', true, seq(tlv(0xa0, ...o.permit.map(h => seq(dns(h))))))] : [])]
    : [ext('2.5.29.19', true, seq()), ext('2.5.29.15', true, bits(Buffer.from([0x80]), 7)), ext('2.5.29.37', false, seq(oid('1.3.6.1.5.5.7.3.1'))),
      ext('2.5.29.17', false, seq(...o.hosts.map(dns))), ext('2.5.29.35', false, seq(tlv(0x80, o.issuerSki)))];
  const tbs = seq(tlv(0xa0, int(Buffer.from([2]))), int(serial), ECDSA_SHA256, o.issuerName,
    seq(time(new Date(now - 864e5)), time(new Date(now + o.days * 864e5))), name(o.cn),
    o.pub.export({ type: 'spki', format: 'der' }), tlv(0xa3, seq(...exts)));
  return seq(tbs, ECDSA_SHA256, bits(crypto.sign('sha256', tbs, o.issuerKey)));
}
const ecKey = () => crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });

// A CA (key + cert) for `hosts`; `permit: false` makes an unconstrained one (tests only).
function newCA(cn = 'fiche local CA', permit = ['api.anthropic.com']) {
  const { publicKey, privateKey } = ecKey();
  const der = makeCert({ cn, pub: publicKey, issuerName: name(cn), issuerKey: privateKey, ca: true, permit: permit || null, days: 3650 });
  return { cert: pem(der, 'CERTIFICATE'), key: privateKey.export({ type: 'pkcs8', format: 'pem' }), name: cn };
}
// A server certificate for `hosts` signed by `ca`, as a TLS secure context.
function leaf(ca, hosts) {
  const issuerKey = crypto.createPrivateKey(ca.key), issuerPub = crypto.createPublicKey(issuerKey);
  const { publicKey, privateKey } = ecKey();
  const der = makeCert({ cn: hosts[0], pub: publicKey, issuerName: name(ca.name), issuerKey, issuerSki: ski(issuerPub), hosts, days: 365 });
  return { cert: pem(der, 'CERTIFICATE'), key: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
}

// The CA kept in the data folder: ca.pem (shared with Claude Code) and ca.key (0600, stays here).
function loadCA(dir) {
  const certFile = path.join(dir, 'ca.pem'), keyFile = path.join(dir, 'ca.key');
  try {
    const ca = { cert: fs.readFileSync(certFile, 'utf8'), key: fs.readFileSync(keyFile, 'utf8'), name: 'fiche local CA', file: certFile };
    if (new crypto.X509Certificate(ca.cert).validToDate > Date.now() + 30 * 864e5) return ca;
  } catch { }
  const ca = newCA();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(keyFile, ca.key, { mode: 0o600 });
  fs.writeFileSync(certFile, ca.cert);
  return { ...ca, file: certFile };
}

const INTERCEPT = new Set(['api.anthropic.com']);

// Wires CONNECT handling into the proxy's http server. `upstream(host)` gives the proxy URL to tunnel
// other hosts through (or undefined for direct).
function attach(srv, ca, upstream) {
  // Intercepted sockets go to an https server that shares the proxy's request handler.
  const inner = require('https').createServer({ ...leaf(ca, [...INTERCEPT]), ALPNProtocols: ['http/1.1'] });
  for (const f of srv.listeners('request')) inner.on('request', f);
  inner.on('secureConnection', t => { t.ficheHost = 'api.anthropic.com'; });
  inner.on('tlsClientError', (e, t) => t?.destroy());
  inner.requestTimeout = 0; inner.headersTimeout = 0;
  const open = new Set(); // CONNECT sockets: the http server stops tracking them, so close() ends them here
  srv.on('connect', (req, sock, head) => {
    open.add(sock); sock.on('close', () => open.delete(sock));
    sock.on('error', () => sock.destroy());
    const [host, portStr] = splitHostPort(req.url), port = Number(portStr) || 443;
    if (INTERCEPT.has(host) && port === 443) {
      sock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) sock.unshift(head);
      inner.emit('connection', sock);
      return;
    }
    tunnel(host, port, upstream(host), (err, up) => {
      if (err) { sock.end(`HTTP/1.1 502 Bad Gateway\r\ncontent-type: text/plain\r\n\r\nfiche proxy: ${err.message}\n`); return; }
      sock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) up.write(head);
      up.pipe(sock); sock.pipe(up);
      up.on('error', () => sock.destroy()); sock.on('close', () => up.destroy());
    });
  });
  return { close() { inner.closeAllConnections?.(); for (const s of open) s.destroy(); } };
}
function splitHostPort(s) {
  const m = /^\[([^\]]+)\](?::(\d+))?$/.exec(s) || /^([^:]+)(?::(\d+))?$/.exec(s);
  return m ? [m[1].toLowerCase(), m[2]] : [s, undefined];
}
// Plain TCP to host:port, directly or through an http(s) proxy's CONNECT.
function tunnel(host, port, proxyURL, cb) {
  if (!proxyURL) {
    const s = net.connect(port, host, () => { s.off('error', fail); cb(null, s); });
    const fail = e => cb(e); s.once('error', fail);
    return;
  }
  const p = new URL(proxyURL), lib = p.protocol === 'https:' ? require('https') : require('http');
  const auth = p.username ? { 'proxy-authorization': 'Basic ' + Buffer.from(`${decodeURIComponent(p.username)}:${decodeURIComponent(p.password)}`).toString('base64') } : {};
  const target = `${host.includes(':') ? `[${host}]` : host}:${port}`;
  const r = lib.request({ host: p.hostname, port: p.port || (p.protocol === 'https:' ? 443 : 80), method: 'CONNECT', path: target, headers: { host: target, ...auth } });
  r.once('connect', (res, s, head) => res.statusCode === 200 ? (head?.length && s.unshift(head), cb(null, s)) : (s.destroy(), cb(new Error(`proxy ${p.host} refused CONNECT (${res.statusCode})`))));
  r.once('error', e => cb(new Error(`proxy ${p.host}: ${e.message}`)));
  r.end();
}

module.exports = { loadCA, newCA, leaf, attach, INTERCEPT };
