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
};

const name = process.argv[2];
if (!tests[name]) { console.error('unknown test ' + name); process.exit(2); }
tests[name]().then(() => process.exit(0), e => { console.error(String(e?.stack || e)); process.exit(1); });
