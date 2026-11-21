// Requests fiche forwards upstream take the same HTTPS_PROXY / NO_PROXY / NODE_EXTRA_CA_CERTS path Claude
// Code itself would have taken (env in ~/.claude/settings.json, else this process's env), so a company
// proxy or a local account router stays in the chain instead of being skipped.
const fs = require('fs'), http = require('http'), https = require('https'), tls = require('tls');
const claude = require('./claude');

// Read per request: the file is small and mtime is too coarse on some filesystems to cache on. With
// fiche itself as HTTPS_PROXY (mitm.js), these are the values from before fiche, so it never loops to itself.
const claudeEnv = () => claude.before();
const pick = (env, k) => env[k] || undefined;

function bypassed(host, noProxy) {
  if (!noProxy) return false;
  host = host.toLowerCase().replace(/^\[|\]$/g, '');
  return String(noProxy).split(',').map(s => s.trim().toLowerCase()).filter(Boolean).some(p => {
    if (p === '*') return true;
    if ((p.match(/:/g) || []).length === 1) p = p.split(':')[0]; // "host:port"; IPv6 literals have more colons
    p = p.replace(/^\*?\./, '');
    return host === p || host.endsWith('.' + p);
  });
}

function tunnelAgent(p, caFile) {
  let ca;
  if (caFile) try { ca = [...tls.rootCertificates, fs.readFileSync(caFile, 'utf8')]; } catch { }
  const agent = new https.Agent({ keepAlive: true, ca });
  agent.createConnection = (opts, cb) => {
    const target = `${opts.host}:${opts.port || 443}`;
    const auth = p.username ? { 'proxy-authorization': 'Basic ' + Buffer.from(`${decodeURIComponent(p.username)}:${decodeURIComponent(p.password)}`).toString('base64') } : {};
    const lib = p.protocol === 'https:' ? https : http;
    const req = lib.request({ host: p.hostname, port: p.port || (p.protocol === 'https:' ? 443 : 80), method: 'CONNECT', path: target, headers: { host: target, ...auth } });
    req.once('connect', (res, socket) => {
      if (res.statusCode !== 200) { socket.destroy(); return cb(new Error(`proxy ${p.host} refused CONNECT (${res.statusCode})`)); }
      cb(null, tls.connect({ socket, servername: opts.servername || opts.host, ca }));
    });
    req.once('error', e => cb(new Error(`proxy ${p.host}: ${e.message}`)));
    req.end();
  };
  return agent;
}

const agents = new Map();
// The agent for an upstream URL, or undefined to connect directly.
function agentFor(url) {
  if (url.protocol !== 'https:') return undefined;
  const env = claudeEnv(), proxy = pick(env, 'HTTPS_PROXY');
  if (!proxy || bypassed(url.hostname, pick(env, 'NO_PROXY'))) return undefined;
  const caFile = pick(env, 'NODE_EXTRA_CA_CERTS') || '', key = proxy + '|' + caFile;
  if (!agents.has(key)) agents.set(key, tunnelAgent(new URL(proxy), caFile));
  return agents.get(key);
}

// The proxy URL to tunnel a CONNECT for `host` through, or undefined for direct.
function proxyFor(host) {
  const env = claudeEnv(), proxy = pick(env, 'HTTPS_PROXY');
  return proxy && !bypassed(host, pick(env, 'NO_PROXY')) ? proxy : undefined;
}

module.exports = { agentFor, proxyFor, bypassed };
