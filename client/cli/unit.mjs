// Tests for the parts cli/smoke.js does not reach: the login item, a second daemon, the browser
// opener and the locale-independent health check. Each one stands for a bug that got through
// once, so they are written to fail the way that bug failed.
//
//   node cli/unit.mjs        (from desktop/)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';

const here = path.dirname(new URL(import.meta.url).pathname);
const CLI = path.join(here, 'fiche.js');
const node = process.execPath;

let failures = 0;
async function test(name, fn) {
  try { await fn(); console.log('  ok   ' + name); }
  catch (e) { failures++; console.log('  FAIL ' + name + '\n       ' + String(e?.message || e).split('\n').join('\n       ')); }
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fiche-unit-'));
const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' };
const run = (args, extra = {}) => new Promise(ok => {
  execFile(node, [CLI, ...args], { env: { ...env, ...(extra.env || {}) }, encoding: 'utf8', timeout: 60000 },
    (err, out, errOut) => ok({ code: err?.code ?? 0, out: String(out || ''), err: String(errOut || '') }));
});
const portFree = () => new Promise(ok => {
  const s = net.createServer();
  s.once('error', () => ok(false));
  s.listen(47321, '127.0.0.1', () => s.close(() => ok(true)));
});

// service.js reads os.homedir() when it loads, so state() here would look at the real home,
// not the isolated one the CLI runs with: the login item is read back through the CLI instead.
const serviceInfo = async () => (JSON.parse((await run(['status', '--json'])).out || '{}')).service || {};
const serviceOn = async () => (await serviceInfo()).on === true;
const platform = await import(path.join(here, 'platform.js'));

console.log('fiche unit tests');

// ---- the browser opener: a missing command must be reported, not assumed to have worked ----
await test('spawnOk says false for a command that is not there', async () => {
  assert.equal(await platform.default.spawnOk('fiche-no-such-command-' + Date.now(), []), false);
});
await test('spawnOk says true for one that is', async () => {
  assert.equal(await platform.default.spawnOk('/bin/sh', ['-c', 'exit 0']), true);
});
await test('openUrl falls through every candidate and admits failure', async () => {
  const saved = process.env.PATH;
  process.env.PATH = path.join(home, 'empty-bin'); // no xdg-open, no gio, no wslview
  try {
    assert.equal(await platform.default.openUrl('https://fiche.ink/'), false,
      'with no opener on PATH openUrl must return false, or `fiche login` prints "Opened your browser" and nothing happens');
  } finally { process.env.PATH = saved; }
});
await test('openUrl refuses anything that is not http(s)', async () => {
  assert.equal(await platform.default.openUrl('file:///etc/passwd'), false);
});

// ---- the login item ----
await test('the launchd plist restarts a crash but respects a clean stop', async () => {
  if (process.platform !== 'darwin') { console.log('       (reads the generator on any platform)'); }
  const body = fs.readFileSync(path.join(here, 'service.js'), 'utf8');
  assert.match(body, /<key>KeepAlive<\/key><dict><key>SuccessfulExit<\/key><false\/><\/dict>/,
    'plain <true/> KeepAlive brings the daemon back right after `fiche stop`');
  assert.match(body, /Restart=on-failure/, 'the systemd unit must not restart a clean exit either');
});

// The second daemon a service manager starts, while one is already running. It has to exit 0:
// launchd (KeepAlive SuccessfulExit) and systemd (Restart=on-failure) restart a daemon that
// fails, so a non-zero exit here is an endless restart loop a few seconds apart.
await test('the proxy moves to a spare port when 47321 is taken, and Claude Code settings follow', async () => {
  const { createRequire } = await import('node:module');
  const req = createRequire(import.meta.url), src = path.join(here, '..', 'app', 'src');
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'fiche-port-')), oldHome = process.env.HOME;
  process.env.HOME = h; fs.mkdirSync(path.join(h, '.claude'));
  const claude = req(path.join(src, 'claude.js')), { createProxy } = req(path.join(src, 'proxy.js'));
  process.env.HOME = oldHome;
  const blocker = net.createServer(); await new Promise(ok => blocker.listen(47321, '127.0.0.1', ok));
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
  } finally { await p.close(); blocker.close(); fs.rmSync(h, { recursive: true, force: true }); }
});

await test('a duplicate daemon exits cleanly instead of looping', async () => {
  assert.equal(await portFree(), true, 'another fiche is using port 47321; stop it before running this');
  let r = await run(['start']);
  assert.equal(r.code, 0, 'start failed: ' + r.out + r.err);
  const dup = await run(['daemon']);
  assert.equal(dup.code, 0, `a duplicate daemon exited ${dup.code}: launchd and systemd would loop on that\n${dup.out}${dup.err}`);
  assert.match(dup.out + dup.err, /already running/);
  const after = JSON.parse((await run(['status', '--json'])).out || '{}');
  assert.equal(after.running, true, 'the duplicate took the first daemon down with it');
  await run(['stop']);
});

// Touching launchd or systemd for real would disturb an install on this machine (the label and
// unit name are the same ones), so this runs where that is safe: CI, and by hand on purpose.
if (process.env.FICHE_TEST_SERVICE === '1') {
  await test('fiche service install leaves exactly one live daemon', async () => {
    assert.equal(await portFree(), true, 'another fiche is using port 47321; stop it before running this');
    let r = await run(['start']);
    assert.equal(r.code, 0, r.out + r.err);
    r = await run(['service', 'install']);
    assert.equal(r.code, 0, r.out + r.err);
    const st = JSON.parse((await run(['status', '--json'])).out || '{}');
    assert.equal(st.running, true, 'the daemon is gone after service install');
    assert.equal(st.proxyListening, true, `the surviving daemon has no port: ${st.proxyError}`);
    const sv = await serviceInfo();
    if (sv.kind === 'systemd') {
      // A systemd user manager is already running and looks for units under its own
      // XDG_CONFIG_HOME, so a unit written into this test's isolated home can never be enabled.
      // The file being right is all that can be checked here; verify.yml does the rest on a
      // machine where the home is the real one.
      assert.ok(sv.file && fs.existsSync(sv.file), `the unit file was not written: ${sv.file}`);
      assert.match(fs.readFileSync(sv.file, 'utf8'), /Restart=on-failure/);
      console.log('       (systemd: unit file checked; enabling needs the real home)');
    } else {
      assert.equal(sv.on, true, `the login item was not written (${sv.kind}: ${sv.file})`);
    }
    // Give the service manager time to try a second copy, then check nothing is flapping.
    await new Promise(r2 => setTimeout(r2, 12000));
    const later = JSON.parse((await run(['status', '--json'])).out || '{}');
    assert.equal(later.running, true, 'nothing is listening 12 s later');
    assert.equal(later.proxyListening, true, `the daemon lost the port: ${later.proxyError}`);
    assert.equal(later.pid, st.pid, `the daemon was restarted (pid ${st.pid} -> ${later.pid}): that is the crash loop`);
  });

  await test('fiche service uninstall keeps fiche running for this session', async () => {
    const r = await run(['service', 'uninstall']);
    assert.equal(r.code, 0, r.out + r.err);
    const sv = await serviceInfo();
    assert.equal(sv.on, false, 'the login item is still there');
    if (sv.file && sv.kind !== 'profile') assert.ok(!fs.existsSync(sv.file), `${sv.file} was left behind`);
    assert.equal(JSON.parse((await run(['status', '--json'])).out || '{}').running, true);
    await run(['stop']);
  });
} else {
  console.log('  skip FICHE_TEST_SERVICE=1 to test the real login item (it touches launchd/systemd)');
}

// ---- the health check does not depend on the language ----
for (const lang of ['en_US.UTF-8', 'ko_KR.UTF-8']) {
  await test(`doctor exits 0 on a working install (LANG=${lang})`, async () => {
    const r = await run(['doctor'], { env: { LANG: lang, LC_ALL: lang } });
    assert.equal(r.code, 0, r.out + r.err);
  });
  await test(`doctor exits non-zero when the renderer cannot load (LANG=${lang})`, async () => {
    // Same tree without the renderer: what a tarball for the wrong platform looks like.
    // The client files have to be copies, not symlinks: client/engine.js finds the engine and
    // the renderer relative to its own __dirname, which node resolves through a symlink.
    const broken = fs.mkdtempSync(path.join(os.tmpdir(), 'fiche-broken-'));
    const root = path.resolve(here, '..');
    const src = fs.existsSync(path.join(root, 'client')) ? path.join(root, 'client') : path.join(root, 'app', 'src');
    fs.mkdirSync(path.join(broken, 'client'));
    for (const f of fs.readdirSync(src)) if (f.endsWith('.js') && !f.includes('.bak')) fs.copyFileSync(path.join(src, f), path.join(broken, 'client', f));
    fs.symlinkSync(path.join(here), path.join(broken, 'cli'));
    for (const name of ['engine', 'vendor', 'package.json']) {
      const from = fs.existsSync(path.join(root, name)) ? path.join(root, name) : path.join(root, 'app', name);
      if (fs.existsSync(from)) fs.symlinkSync(from, path.join(broken, name));
    }
    assert.ok(!fs.existsSync(path.join(broken, 'node_modules')), 'the broken tree must have no renderer');
    const r = await run(['doctor'], { env: { LANG: lang, LC_ALL: lang, FICHE_HOME: broken } });
    assert.notEqual(r.code, 0,
      'install.sh decides from this exit code; in Korean it cannot read the lines instead\n' + r.out + r.err);
    assert.match(r.out, /@napi-rs|renderer|렌더러/, 'the reason should name the renderer');
    fs.rmSync(broken, { recursive: true, force: true });
  });
}

await run(['stop']);
fs.rmSync(home, { recursive: true, force: true });
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
