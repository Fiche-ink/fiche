// Builds the CLI tarballs that install.sh downloads, one per platform.
//
//   node cli/pack.mjs                 all targets
//   node cli/pack.mjs darwin-arm64    one target
//
// Everything in the tarball is plain JavaScript except one native module: @napi-rs/canvas, the
// renderer. Its binding is a single skia.<target>.node file, taken from the platform package on
// npm, so all targets can be built on one machine - there is no mac or Windows in the loop.
// Node itself is not packed; install.sh uses the system node, or downloads the official build.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const TARGETS = ['darwin-arm64', 'darwin-x64', 'linux-x64-gnu', 'linux-arm64-gnu', 'linux-x64-musl', 'linux-arm64-musl'];
// Electron-only files: the CLI has no window, tray or Windows installer.
const GUI_ONLY = ['main.js', 'setup.js', 'startup.js', 'preload.js', 'setup-preload.js'];

const here = path.dirname(new URL(import.meta.url).pathname);
const desktop = path.resolve(here, '..');
const app = path.join(desktop, 'app');
const repo = path.resolve(desktop, '..');
const dist = path.join(desktop, 'dist-cli');
const version = JSON.parse(fs.readFileSync(path.join(app, 'package.json'), 'utf8')).version;
const canvasVersion = JSON.parse(fs.readFileSync(path.join(app, 'package.json'), 'utf8')).dependencies['@napi-rs/canvas'];
const CANVAS_JS = ['index.js', 'index.d.ts', 'geometry.js', 'js-binding.js', 'load-image.js', 'node-canvas.js', 'node-canvas.d.ts', 'package.json'];

const say = (...a) => console.log('pack:', ...a);
const cp = (from, to) => { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to); };

// The engine ships inside the app folder (scripts/sync-engine.js keeps it in step with ../../engine).
function engineFile() {
  for (const f of [path.join(app, 'engine', 'v0.mjs'), path.join(repo, 'engine', 'v0.mjs')]) if (fs.existsSync(f)) return f;
  throw new Error('engine/v0.mjs not found');
}

// skia.<target>.node, from a local install when it is already there, else from npm.
function binding(target) {
  const name = `@napi-rs/canvas-${target}`, file = `skia.${target}.node`;
  for (const base of [path.join(app, 'node_modules'), path.join(repo, 'sdk', 'node_modules')]) {
    const f = path.join(base, name, file);
    if (fs.existsSync(f)) return f;
  }
  fs.mkdirSync(path.join(dist, 'npm'), { recursive: true });
  const out = execFileSync('npm', ['pack', `${name}@${canvasVersion.replace(/^[^\d]*/, '')}`, '--pack-destination', path.join(dist, 'npm')],
    { encoding: 'utf8' }).trim().split('\n').pop();
  const tgz = path.join(dist, 'npm', out);
  execFileSync('tar', ['xzf', tgz, '-C', path.join(dist, 'npm'), `package/${file}`]);
  return path.join(dist, 'npm', 'package', file);
}

function stage(target) {
  const dir = path.join(dist, `stage-${target}`, 'fiche');
  fs.rmSync(path.join(dist, `stage-${target}`), { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  // 1. the CLI
  for (const f of fs.readdirSync(here))
    if ((f.endsWith('.js') || f.endsWith('.mjs')) && f !== 'pack.mjs') cp(path.join(here, f), path.join(dir, 'cli', f));
  cp(path.join(here, 'fiche.sh'), path.join(dir, 'bin', 'fiche'));
  fs.chmodSync(path.join(dir, 'bin', 'fiche'), 0o755);

  // 2. the open client, minus the Electron-only files
  for (const f of fs.readdirSync(path.join(app, 'src')))
    if (f.endsWith('.js') && !f.includes('.bak') && !GUI_ONLY.includes(f)) cp(path.join(app, 'src', f), path.join(dir, 'client', f));

  // 3. engine and fonts
  cp(engineFile(), path.join(dir, 'engine', 'v0.mjs'));
  for (const f of fs.readdirSync(path.join(app, 'vendor'))) cp(path.join(app, 'vendor', f), path.join(dir, 'vendor', f));

  // 4. the renderer: wrapper JS plus this target's binding
  const cdir = path.join(app, 'node_modules', '@napi-rs', 'canvas');
  for (const f of CANVAS_JS) if (fs.existsSync(path.join(cdir, f))) cp(path.join(cdir, f), path.join(dir, 'node_modules', '@napi-rs', 'canvas', f));
  cp(binding(target), path.join(dir, 'node_modules', '@napi-rs', 'canvas', `skia.${target}.node`));

  // 5. manifest and licences
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: 'fiche', version, private: true, description: 'fiche CLI client (optical context compression for Claude Code)',
    bin: { fiche: 'bin/fiche' }, target, license: 'MIT',
  }, null, 2) + '\n');
  for (const f of ['LICENSE', 'VERIFY.md']) {
    const src = [path.resolve(repo, '..', 'fiche-repos', 'fiche', f), path.join(repo, f), path.join(desktop, f)].find(p => fs.existsSync(p));
    if (src) cp(src, path.join(dir, f));
  }
  return path.join(dist, `stage-${target}`);
}

function build(target) {
  const base = stage(target);
  // Stable name (no version): install.sh can fetch it from releases/latest/download/.
  // The version is inside, in package.json.
  const out = path.join(dist, `fiche-cli-${target}.tar.gz`);
  // Fixed owner and timestamps: the same input gives the same tarball, so the SHA-256 in the
  // release notes can be reproduced (VERIFY.md).
  execFileSync('tar', ['czf', out, '-C', base, '--owner=0', '--group=0', '--numeric-owner',
    '--mtime=2026-01-01 00:00:00Z', '--sort=name', 'fiche']);
  const size = (fs.statSync(out).size / 1e6).toFixed(1);
  say(`${path.basename(out)}  ${size} MB`);
  return out;
}

const want = process.argv.slice(2).filter(a => !a.startsWith('-'));
const list = want.length ? want : TARGETS;
for (const t of list) {
  if (!TARGETS.includes(t)) { console.error('unknown target:', t, '\nknown:', TARGETS.join(' ')); process.exit(2); }
}
fs.mkdirSync(dist, { recursive: true });
const files = list.map(build);
// SHA256SUMS next to the tarballs, for install.sh and for anyone checking a download by hand.
const sums = execFileSync(process.platform === 'darwin' ? 'shasum' : 'sha256sum',
  (process.platform === 'darwin' ? ['-a', '256'] : []).concat(files.map(f => path.basename(f))),
  { cwd: dist, encoding: 'utf8' });
fs.writeFileSync(path.join(dist, 'SHA256SUMS'), sums);
say('wrote', path.join(dist, 'SHA256SUMS'));
console.log(sums.trim());
