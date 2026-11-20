# Verifying fiche

fiche sits between Claude Code and Anthropic on your own machine and folds old conversation turns into page images, so long Claude Code sessions send fewer input tokens. There is a Windows app and, for macOS, Linux and Claude Code inside WSL2, a command line client that runs the same code without a window.

Because a local proxy on that path sees your Claude Code traffic and login headers, this document lists every host fiche contacts, explains how the client source and local engine are structured, and shows five ways to verify what the installed client does on your machine.

## Where traffic goes

fiche sends requests to three destinations, and nothing else:

### 1. `api.anthropic.com`
Your Claude Code requests after fiche compressed them, sent with your own Claude login headers exactly as Claude Code sent them. fiche does not store or forward those headers anywhere else.

### 2. `judge.fiche.ink`

#### Judge numbers

Per-block numbers (length, line stats, character-class shares, entropy, counts) plus salted one-way IDs. The salt is fixed per install, so the same block from the same PC always gets the same ID; it cannot be matched across PCs or reversed.

#### Outcome signals (only with Data contribution on)

The kind of event (such as a re-read or failed Edit), tool name, time, and the same salted IDs.

#### Shape sequences (only with Data contribution on)

Up to 512 characters per block where each character is replaced by its class: Hangul → `g`, lowercase → `a`, uppercase → `A`, digit → `0`, space or tab → `_`, newline → `/`, any symbol → `.`, other scripts → `x`, and each character in a random-looking run → `r`. The original characters are never sent.

#### Never sent

Text, code, and file paths.

#### Settings control

Turning off **Data contribution** in Settings keeps judge requests going, because every block still needs a decision, but the server stores nothing from them for training: no judgments, outcome signals, shape sequences, or usage reports. You can turn it back on at any time.

### 3. `api.fiche.ink`

Your fiche account. Sign-in happens in your browser (GitHub or Google); the app receives its own API key through a one-time code on `127.0.0.1`. The app then reads your film balance and early tester progress, and saves two settings: the Claude plan you picked and the Data contribution switch. While Data contribution is on, every 6 hours it also sends a usage report: that plan, pixels drawn in the last 7 days, and the 5-hour and 7-day usage numbers Claude Code already receives in its response headers.

## Published client source vs. local engine

The public repository at [github.com/fiche-ink/fiche](https://github.com/fiche-ink/fiche) contains the network-facing client source in `client/src`:

| Module | Role |
|---|---|
| `proxy.js` | Local proxy |
| `net.js` | Single module every fiche request goes through |
| `engine.js` | Attaches the client network handler to the compression engine via `setNet()` |
| `claude.js` | Claude Code settings writer |
| `setup.js` | Installer and uninstaller (copies the app, makes shortcuts and the Installed apps entry; no network) |
| `meter.js` | Savings meter |
| `account.js` | Sign-in (browser → loopback → one-time code) and account calls to `api.fiche.ink` |
| Electron main / preload | Main process and preload modules (Windows app only) |

The macOS, Linux and WSL2 build runs the same modules with no Electron at all. Its own files are in `client/cli`:

| Module | Role |
|---|---|
| `cli/daemon.js` | What `main.js` does in the app: run the proxy, keep Claude Code connected, own the account key |
| `cli/fiche.js` | The `fiche` command; talks to the daemon over a unix socket in your own run folder |
| `cli/control.js` | That socket. It is not a TCP port, so only your user can reach the daemon |
| `cli/paths.js`, `cli/platform.js`, `cli/service.js` | Where files live, WSL and systemd detection, the login item |
| `cli/install.sh` | The installer behind `curl -fsSL https://fiche.ink/install.sh \| sh` |
| `cli/install.ps1` | The Windows installer behind `irm https://fiche.ink/install.ps1 \| iex`: it unpacks the zip build and lets the app register itself |
| `cli/pack.mjs` | Builds the release tarballs |

Two differences from the app are worth knowing. Without Electron there is no `safeStorage`, so the account key is a file with `0600` permissions in your config folder instead of being encrypted with your login credentials. And nothing in the release is signed by a certificate: `install.sh` verifies each download against the `SHA256SUMS` file published with the release, and the same hashes are printed in the release notes.

The compression engine is not published in the repository. It ships locally as readable JavaScript at `engine/v0.mjs` (outside `app.asar` in the Windows app, and under `~/.local/share/fiche/current/engine/v0.mjs` in the CLI install).

The engine has no network path of its own: the client hands it a `request` function via `setNet()` (`client/src/engine.js`). If you open `engine/v0.mjs`, you will see one `fetch` call in the file. That `fetch` is only the default used when no client attached a handler (fiche's own Linux test rig); the app always replaces it before the first request. It imports only `fs`, `crypto`, `zlib`, `os`, and the canvas library used for drawing pages — never `http`, `https`, `net`, or `tls` — which you can check directly in `engine/v0.mjs` inside the installed app.

## Five ways to verify

### 1. Read the network modules

Read `client/src/net.js` and `client/src/proxy.js` in the [fiche-ink/fiche](https://github.com/fiche-ink/fiche) repository to inspect every outbound request path, along with `client/src/engine.js` to see how `setNet()` wires the engine into the client.

### 2. Compare the installed app against a release tag

Windows builds are published on the [Releases](https://github.com/fiche-ink/fiche/releases) page: the installer `.exe` and the `fiche-win-x64.zip` that `install.ps1` unpacks. Neither is signed by a certificate, so check the SHA-256 in the release notes first (`certutil -hashfile <file> SHA256`); `install.ps1` does that check itself against the release's `SHA256SUMS`. After installing, extract `app.asar` and compare the packaged client source against `client/src` at the matching release tag:

```cmd
npx @electron/asar extract "%LOCALAPPDATA%\Programs\fiche\resources\app.asar" fiche-src
```

Then diff `fiche-src/src` against `client/src` at that tag. You can also read `engine/v0.mjs` directly in the installed app directory outside `app.asar`.

### 3. Compare the macOS, Linux or WSL2 install against this source

The tarball is plain files, so there is nothing to extract first:

```sh
shasum -a 256 fiche-cli-darwin-arm64.tar.gz   # on Linux, use sha256sum; compare with SHA256SUMS
diff -r ~/.local/share/fiche/current/client  client/src   # shared modules (Windows-only Electron files are only in client/src)
diff -r ~/.local/share/fiche/current/cli     client/cli   # CLI runtime files (installer and build scripts are only in client/cli)
```

The only files that are not readable text are `node_modules/@napi-rs/canvas` (the published npm package for your platform that `engine/v0.mjs` uses to render), the three font files under `vendor/`, and the bundled `node` when the installer had to download one from nodejs.org. `fiche log` prints the same sent log the app shows, and `SSLKEYLOGFILE` works the same way.

### 4. Check the sent log

In the Windows app, go to **History** → **Sent log**. On macOS, Linux and WSL2, run `fiche log`. Every outbound request is listed there, and requests to fiche servers show the exact body sent.

### 5. Capture and decrypt TLS traffic with Wireshark

To inspect live traffic outside the app:

1. Set the environment variable `SSLKEYLOGFILE` to a file path. In the Windows app, quit fiche from the tray icon and start it again so it picks up the variable. On macOS, Linux and WSL2, run `fiche stop` and then start it again with `SSLKEYLOGFILE=/path/to/keys fiche start`.
2. Open Wireshark, go to **Preferences → Protocols → TLS**, and set **(Pre)-Master-Secret log filename** to that file path.
3. Filter on `tls.handshake.extensions_server_name` to check destination hostnames. From fiche, only `api.anthropic.com`, `judge.fiche.ink` and `api.fiche.ink` should appear. Other programs on your PC show up too, so close what you can, or compare a capture with fiche quit.
4. Inspect the decrypted HTTP bodies to verify the exact payloads leaving your machine.

## Contact

Questions or findings: hello@fiche.ink
