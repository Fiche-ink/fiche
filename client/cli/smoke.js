// End-to-end smoke test for the CLI client (macOS, Linux, WSL2).
//
// It runs the real daemon in an isolated HOME, with a stand-in judge server (every block it is
// asked about comes back as an image) and a stand-in upstream in place of api.anthropic.com, then
// pushes one synthetic Claude Code request through 127.0.0.1:47321 and checks that
//   1. the request reached the upstream as page images, smaller than it went in,
//   2. `fiche status` counts it as compressed,
//   3. Claude Code's settings.json was pointed at the proxy and put back on exit.
// Run:  node cli/smoke.js        (from desktop/)
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const { spawn, execFileSync } = require('child_process');

const CLI = path.join(__dirname, 'fiche.js');
const JUDGE_PORT = 47398, UP_PORT = 47399;
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fiche-cli-smoke-'));
// Same place cli/paths.js picks, which is not the same on both platforms.
const dataDir = process.platform === 'darwin'
  ? path.join(home, 'Library', 'Application Support', 'fiche')
  : path.join(home, '.config', 'fiche');
const settings = path.join(home, '.claude', 'settings.json');
// LC_ALL wins over LANG, and the runners set one or both, so the locale is pinned here rather
// than assumed - both for the English checks below and for the Korean one.
const locale = l => ({ LANG: l, LC_ALL: l, LC_MESSAGES: l });
const env = {
  ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'),
  FICHE_JUDGE_URL: `http://127.0.0.1:${JUDGE_PORT}`, FICHE_API: `http://127.0.0.1:${JUDGE_PORT}`,
  ...locale('en_US.UTF-8'),
};
const fiche = (...args) => execFileSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8' });

const big = n => Array.from({ length: n }, (_, i) => `line ${i}: const value_${i} = compute(${i}) // 결과를 확인합니다`).join('\n');
const turn = i => [
  { role: 'assistant', content: [{ type: 'tool_use', id: `tu_${i}`, name: 'Bash', input: { command: `cat file_${i}.js` } }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: `tu_${i}`, content: big(400) }] },
];
const payload = {
  model: 'claude-opus-5-5', max_tokens: 1024, stream: true,
  system: [{ type: 'text', text: 'You are Claude Code, a CLI for Claude.' }],
  tools: [{ name: 'Bash', description: 'Run a command', input_schema: { type: 'object', properties: { command: { type: 'string' } } } }],
  messages: [{ role: 'user', content: 'Read the files and summarize them.' }, ...[0, 1, 2, 3, 4].flatMap(turn),
    { role: 'assistant', content: [{ type: 'text', text: 'Reading done.' }] }, { role: 'user', content: 'Thanks, now summarize.' }],
};

const fail = m => { console.error('smoke failed:', m); cleanup(1); };
let judge, up, received = null;
function cleanup(code) {
  try { fiche('stop'); } catch { }
  try { judge?.close(); up?.close(); } catch { }
  try { fs.rmSync(home, { recursive: true, force: true }); } catch { }
  process.exit(code);
}

function serve(port, handler) {
  const srv = http.createServer(handler);
  return new Promise(ok => srv.listen(port, '127.0.0.1', () => ok(srv)));
}
const read = req => new Promise(ok => { const c = []; req.on('data', d => c.push(d)); req.on('end', () => ok(Buffer.concat(c))); });

(async () => {
  // Stand-in judge: images for everything it is asked about, and a /v1/* account API that says ok.
  // The film balance the real /v1/me answers with: server/src/ledger.js summary(), nested under
  // "film" by server/src/index.js. The shape matters - the CLI used to read keys that are not
  // there and showed 0 film to everyone.
  const ME = {
    account_id: 'acc_smoke', email: 'smoke@example.com',
    film: {
      mode: 'beta', plan: 'pro', contrib: false,
      film: { freeFrames: 50, paidFrames: 200, usableFrames: 250 },
      grants: [{ source: 'signup', frames: 50, usedFrames: 0, expires: null }],
      paid: true,
      today: { frames: 12, calls: 3, capFrames: 200 },
      early: null,
    },
  };
  judge = await serve(JUDGE_PORT, async (req, res) => {
    const body = await read(req);
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.url.startsWith('/v1/judge')) {
      const blocks = JSON.parse(body.toString('utf8')).blocks || [];
      return res.end(JSON.stringify({ decisions: blocks.map(b => ({ id: b.id, decision: 'image',
        render: { kind: 'code', codePx: 12, codeColW: 640, codeColMin: 200, codeColPct: 1, codeGap: 16, proseKr: 17, proseLatin: 15 } })) }));
    }
    if (req.url.startsWith('/v1/me')) return res.end(JSON.stringify(ME));
    if (req.url.startsWith('/v1/profile')) return res.end(JSON.stringify({ ok: true, film: ME.film }));
    res.end(JSON.stringify({ ok: true }));
  });
  // Stand-in upstream: records what the proxy forwarded, answers like a (non-streaming) message.
  up = await serve(UP_PORT, async (req, res) => {
    received = await read(req);
    res.writeHead(200, { 'content-type': 'application/json', 'anthropic-ratelimit-unified-5h-utilization': '12' });
    res.end(JSON.stringify({ type: 'message', role: 'assistant', content: [{ type: 'text', text: 'ok' }] }));
  });

  // A signed-in account and an upstream that is not Anthropic.
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  // settings.json already points at another router: fiche must remember it, use it as the
  // upstream while connected, and put it back on exit (the case of a local router already in front of Claude Code).
  fs.writeFileSync(settings, JSON.stringify({ env: { EXISTING: 'keep-me', ANTHROPIC_BASE_URL: `http://127.0.0.1:${UP_PORT}` } }, null, 2));
  fs.writeFileSync(path.join(dataDir, 'account.json'), JSON.stringify({ key: 'fk_' + 'smoketestkey'.padEnd(24, 'x'), email: 'smoke@example.com' }));
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ proxyOn: true, contrib: false }));

  console.log(fiche('start').trim());

  const st0 = JSON.parse(fiche('status', '--json'));
  if (!st0.running) fail('daemon did not start');
  if (!st0.proxyListening) fail(`the proxy could not listen: ${st0.proxyError}. Stop any other fiche first (fiche stop).`);
  if (!st0.account.signedIn) fail(`the daemon did not pick up the test account in ${dataDir}`);
  if (!st0.connected) fail('Claude Code settings.json was not connected');
  if (st0.upstream !== `http://127.0.0.1:${UP_PORT}`) fail('the existing router was not kept as upstream: ' + st0.upstream);
  const s = JSON.parse(fs.readFileSync(settings, 'utf8'));
  if (s.env.ANTHROPIC_BASE_URL !== 'http://127.0.0.1:47321') fail('ANTHROPIC_BASE_URL not set: ' + JSON.stringify(s.env));
  if (s.env.EXISTING !== 'keep-me') fail('an existing env entry was lost');

  const sent = Buffer.from(JSON.stringify(payload));
  const res = await new Promise((ok, no) => {
    const r = http.request({ host: '127.0.0.1', port: 47321, method: 'POST', path: '/v1/messages',
      headers: { 'content-type': 'application/json', 'x-api-key': 'test', 'content-length': sent.length } },
      async r2 => ok({ status: r2.statusCode, body: await read(r2) }));
    r.on('error', no); r.end(sent);
  });
  if (res.status !== 200) fail('proxy answered ' + res.status + ' ' + res.body.toString().slice(0, 200));
  if (!received) fail('the upstream received nothing');

  const got = JSON.parse(received.toString('utf8'));
  const images = JSON.stringify(got).split('"type":"image"').length - 1;
  if (!images) fail('no page images in the forwarded request');
  // Bytes grow (base64 PNG is bulkier than the text it replaces); the saving is in tokens, which
  // is what the API charges for. The meter below is the check that matters.
  const ratio = received.length / sent.length;

  const st = JSON.parse(fiche('status', '--json'));
  if (st.stats.compressed !== 1) fail('status says compressed=' + st.stats.compressed);
  if (!st.account.signedIn) fail('status says signed out');
  // The film line users actually read: 250 frames is "2 rolls 50 frames".
  if (st.account.me?.film?.film?.usableFrames !== 250) fail('the film balance did not arrive: ' + JSON.stringify(st.account.me?.film || null));
  const shown = fiche('status');
  if (!/2 rolls 50 frames left/.test(shown)) fail('fiche status does not show the film balance:\n' + shown);
  if (!/today 12 frames of 2 rolls/.test(shown)) fail('fiche status does not show today against the beta cap:\n' + shown);
  const shownKo = execFileSync(process.execPath, [CLI, 'status'], { env: { ...env, ...locale('ko_KR.UTF-8') }, encoding: 'utf8' });
  if (!/2롤 50컷 남음/.test(shownKo)) fail('the Korean film line is wrong:\n' + shownKo);
  const stats = JSON.parse(fiche('stats', '--json'));
  if (!(stats.today.before > stats.today.after)) fail('the savings meter recorded nothing');
  if (stats.today.after / stats.today.before > 0.75) fail(`only ${Math.round((1 - stats.today.after / stats.today.before) * 100)}% of the input tokens were saved`);
  if (!Object.keys(st.limits).length) fail('the limit headers were not read');

  fiche('stop');
  const after = JSON.parse(fs.readFileSync(settings, 'utf8'));
  if (after.env.ANTHROPIC_BASE_URL !== `http://127.0.0.1:${UP_PORT}`) fail('the previous router was not put back on exit: ' + after.env.ANTHROPIC_BASE_URL);
  if (after.env.EXISTING !== 'keep-me') fail('settings.json lost an existing entry on exit');

  console.log('smoke:', JSON.stringify({ images, bytes: `${sent.length} -> ${received.length} (${ratio.toFixed(2)}x, base64)`,
    tokens: `${stats.today.before} -> ${stats.today.after} (-${Math.round((1 - stats.today.after / stats.today.before) * 100)}%)`,
    limits: st.limits, restored: true }));
  cleanup(0);
})().catch(e => fail(e?.stack || e));
