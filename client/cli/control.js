// Control channel between `fiche <command>` and the running daemon.
//
// A unix socket in the user's own run folder, not a TCP port: file permissions (0700 folder)
// decide who may talk to the daemon, so there is no token to leak and no second port to open.
// One line of JSON in, one line of JSON out.
const net = require('net'), fs = require('fs'), path = require('path');
const P = require('./paths');

function listen(handle) {
  P.ensure();
  try { fs.chmodSync(P.runDir, 0o700); } catch { }
  const srv = net.createServer(conn => {
    let buf = '';
    conn.setEncoding('utf8');
    conn.on('data', async d => {
      buf += d;
      const i = buf.indexOf('\n');
      if (i < 0) { if (buf.length > 1e6) conn.destroy(); return; }
      let req = null;
      try { req = JSON.parse(buf.slice(0, i)); } catch { conn.end('{"error":"bad_request"}\n'); return; }
      buf = '';
      let out;
      try { out = await handle(req.action, req.args || {}); }
      catch (e) { out = { error: String(e?.message || e) }; }
      try { conn.end(JSON.stringify(out === undefined ? null : out) + '\n'); } catch { }
    });
    conn.on('error', () => { });
  });
  return new Promise((ok, fail) => {
    srv.once('error', async e => {
      // A socket file left behind by a daemon that is gone: nobody answers, so replace it.
      if (e.code !== 'EADDRINUSE') return fail(e);
      if (await alive()) return fail(Object.assign(new Error('fiche is already running'), { code: 'ERUNNING' }));
      try { fs.unlinkSync(P.sock); } catch { }
      srv.listen(P.sock, () => ok(srv));
    });
    srv.listen(P.sock, () => { try { fs.chmodSync(P.sock, 0o600); } catch { } ok(srv); });
  });
}

// Sends one command to the daemon. Rejects with code ENOTRUNNING when there is nothing listening.
function send(action, args = {}, timeoutMs = 20000) {
  return new Promise((ok, fail) => {
    const conn = net.createConnection(P.sock);
    let buf = '', done = false;
    const end = (err, val) => { if (done) return; done = true; clearTimeout(t); try { conn.destroy(); } catch { } err ? fail(err) : ok(val); };
    const t = setTimeout(() => end(Object.assign(new Error('daemon did not answer'), { code: 'ETIMEOUT' })), timeoutMs);
    conn.setEncoding('utf8');
    conn.on('connect', () => conn.write(JSON.stringify({ action, args }) + '\n'));
    conn.on('data', d => {
      buf += d;
      const i = buf.indexOf('\n');
      if (i < 0) return;
      try { end(null, JSON.parse(buf.slice(0, i))); } catch (e) { end(e); }
    });
    conn.on('error', e => end(e.code === 'ENOENT' || e.code === 'ECONNREFUSED'
      ? Object.assign(new Error('fiche is not running'), { code: 'ENOTRUNNING' }) : e));
    conn.on('close', () => end(Object.assign(new Error('connection closed'), { code: 'ECLOSED' })));
  });
}

async function alive() {
  try { await send('ping', {}, 3000); return true; } catch { return false; }
}

module.exports = { listen, send, alive };
