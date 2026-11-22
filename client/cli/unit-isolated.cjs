// Tests that load claude.js (which writes ~/.claude/settings.json). unit.mjs runs this only as a child
// process whose HOME is a fresh temp folder. 2026-11-22: the same tests run in-process cached the real
// settings path and overwrote the real settings.json, cutting every Claude Code session on the machine.
const fs = require('fs'), os = require('os'), path = require('path'), net = require('net'), assert = require('assert/strict');

const sandbox = process.env.FICHE_TEST_SANDBOX;
const inTmp = p => !!p && path.resolve(p).startsWith(fs.realpathSync(os.tmpdir()) + path.sep);
if (!sandbox || os.homedir() !== sandbox || !inTmp(fs.realpathSync(sandbox)) || !/fiche-iso-/.test(sandbox)) {
  console.error('refusing to run: HOME is not a fiche-iso- temp folder (' + os.homedir() + ')');
  process.exit(3);
}

// desktop/app/src in the app repo, client/src in the public one.
const src = [path.join(__dirname, '..', 'app', 'src'), path.join(__dirname, '..', 'src')].find(d => fs.existsSync(path.join(d, 'claude.js')));
const claude = require(path.join(src, 'claude.js'));
if (!inTmp(fs.realpathSync(path.dirname(claude.FILE))) || !claude.FILE.startsWith(sandbox + path.sep)) {
  console.error('refusing to run: settings path is outside the sandbox (' + claude.FILE + ')');
  process.exit(3);
}
const { bypassed } = require(path.join(src, 'upproxy.js'));
const { createProxy } = require(path.join(src, 'proxy.js'));

const tests = {
  async noProxy() {
    assert.equal(bypassed('api.anthropic.com', 'localhost,127.0.0.1,::1'), false);
    assert.equal(bypassed('api.anthropic.com', '.anthropic.com'), true);
    assert.equal(bypassed('api.anthropic.com', 'anthropic.com:443'), true);
    assert.equal(bypassed('notanthropic.com', 'anthropic.com'), false);
    assert.equal(bypassed('::1', '::1'), true);
    assert.equal(bypassed('anything', '*'), true);
  },
  async portMove() {
    const blocker = net.createServer();
    await new Promise((ok, no) => { blocker.once('error', no); blocker.listen(47321, '127.0.0.1', ok); });
    const p = createProxy(() => ({ proxyOn: false }));
    try {
      assert.equal(await p.listen(undefined), 47331);
      const read = () => JSON.parse(fs.readFileSync(claude.FILE, 'utf8')).env?.ANTHROPIC_BASE_URL;
      fs.writeFileSync(claude.FILE, JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'http://localhost:9999' } }));
      assert.equal(claude.connect('http://127.0.0.1:47321').prev, 'http://localhost:9999');
      assert.equal(claude.connect('http://127.0.0.1:47331').prev, undefined, 'an old fiche port must not become the upstream');
      assert.equal(read(), 'http://127.0.0.1:47331');
      claude.disconnect('http://127.0.0.1:47321', 'http://localhost:9999');
      assert.equal(read(), 'http://localhost:9999', 'uninstall passes the default port and must still restore');
    } finally { await p.close(); blocker.close(); }
  },
  // HTTPS_PROXY mode: Claude Code -> fiche (CONNECT, opened with the local CA) -> the proxy and CA it had
  // before -> Anthropic. Other hosts are tunnelled untouched. Disconnect puts every key back.
  async mitm() {
    const https = require('https'), http = require('http'), tls = require('tls');
    const mitm = require(path.join(src, 'mitm.js'));
    const dir = fs.mkdtempSync(path.join(sandbox, 'data-'));
    // Stand-ins: "Anthropic" with a cert from a test CA, and the old front proxy that sends every CONNECT there.
    const testCA = mitm.newCA('test CA', false), testCAFile = path.join(dir, 'test-ca.pem');
    fs.writeFileSync(testCAFile, testCA.cert);
    const api = https.createServer(mitm.leaf(testCA, ['api.anthropic.com', 'other.test']), (q, r) => r.end(JSON.stringify({ path: q.url, host: q.headers.host })));
    await new Promise(ok => api.listen(0, '127.0.0.1', ok));
    const seen = [], front = http.createServer();
    front.on('connect', (q, sock) => { seen.push(q.url); const u = net.connect(api.address().port, '127.0.0.1', () => { sock.write('HTTP/1.1 200 OK\r\n\r\n'); u.pipe(sock); sock.pipe(u); }); });
    await new Promise(ok => front.listen(0, '127.0.0.1', ok));
    const frontURL = `http://127.0.0.1:${front.address().port}`;
    fs.writeFileSync(claude.FILE, JSON.stringify({ env: { HTTPS_PROXY: frontURL, NODE_EXTRA_CA_CERTS: testCAFile, KEEP: '1' } }));
    const env = () => JSON.parse(fs.readFileSync(claude.FILE, 'utf8')).env || {};

    const p = createProxy(() => ({ proxyOn: false }));
    const port = await p.listen(undefined), url = `http://127.0.0.1:${port}`;
    const ca = mitm.loadCA(dir), bundle = path.join(dir, 'claude-ca.pem');
    p.mitm(ca); claude.useCA({ ca: ca.file, bundle });
    // Through CONNECT to fiche, trusting only what NODE_EXTRA_CA_CERTS would add.
    const get = host => new Promise((ok, no) => {
      const c = http.request({ host: '127.0.0.1', port, method: 'CONNECT', path: `${host}:443` });
      c.on('connect', (res, sock) => {
        if (res.statusCode !== 200) return no(new Error('CONNECT ' + res.statusCode));
        const t = tls.connect({ socket: sock, servername: host, ca: fs.readFileSync(env().NODE_EXTRA_CA_CERTS, 'utf8') }, () => {
          const issuer = t.getPeerCertificate().issuer.CN;
          const r = https.request({ createConnection: () => t, host, path: '/v1/models', headers: { host } }, res2 => {
            let b = ''; res2.on('data', d => b += d); res2.on('end', () => { t.destroy(); ok({ issuer, body: JSON.parse(b) }); });
          });
          r.on('error', no); r.end();
        });
        t.on('error', no);
      });
      c.on('error', no); c.end();
    });
    try {
      assert.equal(claude.isConnected(url), false);
      claude.connect(url);
      const e = env();
      assert.equal(e.HTTPS_PROXY, url); assert.equal(e.ANTHROPIC_BASE_URL, url); assert.equal(e.NODE_EXTRA_CA_CERTS, bundle);
      assert.equal(claude.isConnected(url), true);
      assert.equal((fs.readFileSync(bundle, 'utf8').match(/BEGIN CERTIFICATE/g) || []).length, 2, 'bundle keeps the old CA and adds fiche');
      assert.equal(claude.before().HTTPS_PROXY, frontURL, 'the old proxy stays upstream, not fiche itself');

      const a = await get('api.anthropic.com');
      assert.equal(a.issuer, 'fiche local CA', 'api.anthropic.com is opened by fiche');
      assert.deepEqual(a.body, { path: '/v1/models', host: 'api.anthropic.com' });
      const o = await get('other.test');
      assert.equal(o.issuer, 'test CA', 'other hosts pass through untouched');
      assert.deepEqual(seen, ['api.anthropic.com:443', 'other.test:443']);
      assert.equal(require(path.join(src, 'net.js')).list().filter(e => e.kind === 'anthropic').length, 0, 'calls other than POST /v1/messages stay out of the sent log');

      claude.connect(url); // reconnect at the next start must not stack markers or lose the old values
      claude.disconnect(url, null);
      assert.deepEqual(env(), { HTTPS_PROXY: frontURL, NODE_EXTRA_CA_CERTS: testCAFile, KEEP: '1' });
      assert.equal(fs.existsSync(claude.FILE + '.fiche-proxy'), false);
    } finally { await p.close(); api.close(); front.close(); }
  },
};

const name = process.argv[2];
if (!tests[name]) { console.error('unknown test ' + name); process.exit(2); }
tests[name]().then(() => process.exit(0), e => { console.error(String(e?.stack || e)); process.exit(1); });
