# Verifying fiche

fiche is a Windows app that sits between Claude Code and Anthropic and folds old conversation turns into page images so long Claude Code sessions send fewer input tokens.

Because a local proxy on that path sees your Claude Code traffic and login headers, this document lists every host fiche contacts, explains how the client source and local engine are structured, and shows four ways to verify what the installed app does on your machine.

## Where traffic goes

fiche sends requests to three destinations, and nothing else:

### 1. `api.anthropic.com`
Your Claude Code requests after fiche compressed them, sent with your own Claude login headers exactly as Claude Code sent them. fiche does not store or forward those headers anywhere else.

### 2. `judge.fiche.ink`

#### Judge numbers

Per-block numbers (length, line stats, character-class shares, entropy, counts) plus salted one-way IDs. The salt is fixed per install, so the same block from the same PC always gets the same ID; it cannot be matched across PCs or reversed.

#### Outcome signals

The kind of event (such as a re-read or failed Edit), tool name, time, and the same salted IDs.

#### Shape sequences (only with Data contribution on)

Up to 512 characters per block where each character is replaced by its class: Hangul → `g`, lowercase → `a`, uppercase → `A`, digit → `0`, space or tab → `_`, newline → `/`, any symbol → `.`, other scripts → `x`, and a random-looking run → `r`. The original characters are never sent.

#### Never sent

Text, code, and file paths.

#### Settings control

Turning off **Data contribution** (데이터 기여) in Settings keeps judge requests going, because every block still needs a decision, but the server stores nothing from them for training: no judgments, outcome signals, shape sequences, or usage reports. You can turn it back on at any time.

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
| Electron main / preload | Main process and preload modules |

The compression engine is not published in the repository. It ships inside the installed app as `engine/v0.mjs` (readable JavaScript, outside `app.asar`) and runs locally.

The engine has no network path of its own: the client hands it a `request` function via `setNet()` (`client/src/engine.js`). If you open `engine/v0.mjs`, you will see one `fetch` call in the file. That `fetch` is only the default used when no client attached a handler (fiche's own Linux test rig); the app always replaces it before the first request. It imports only `fs`, `crypto`, `zlib`, `os`, and the canvas library used for drawing pages — never `http`, `https`, `net`, or `tls` — which you can check directly in `engine/v0.mjs` inside the installed app.

## Four ways to verify

### 1. Read the network modules

Read `client/src/net.js` and `client/src/proxy.js` in the [fiche-ink/fiche](https://github.com/fiche-ink/fiche) repository to inspect every outbound request path, along with `client/src/engine.js` to see how `setNet()` wires the engine into the client.

### 2. Compare the installed app against a release tag

Windows installers are published on the [Releases](https://github.com/fiche-ink/fiche/releases) page (unsigned during the open beta). After installing, extract `app.asar` and compare the packaged client source against `client/src` at the matching release tag:

```cmd
npx @electron/asar extract "%LOCALAPPDATA%\Programs\fiche\resources\app.asar" fiche-src
```

First check the installer's SHA-256 against the one in the release notes (`certutil -hashfile fiche-setup.exe SHA256`). Then diff `fiche-src/src` against `client/src` at that tag. You can also read `engine/v0.mjs` directly in the installed app directory outside `app.asar`.

### 3. Check the in-app sent log

Open fiche and go to **기록** (History) → **보낸 기록** (Sent log). Every outbound request is listed there. Requests to fiche servers can be expanded to show the exact body sent.

### 4. Capture and decrypt TLS traffic with Wireshark

To inspect live traffic outside the app:

1. Set the environment variable `SSLKEYLOGFILE` to a file path, then quit fiche from the tray icon and start it again so it picks up the variable.
2. Open Wireshark, go to **Preferences → Protocols → TLS**, and set **(Pre)-Master-Secret log filename** to that file path.
3. Filter on `tls.handshake.extensions_server_name` to check destination hostnames. From fiche, only `api.anthropic.com` and `judge.fiche.ink` should appear. Other programs on your PC show up too, so close what you can, or compare a capture with fiche quit.
4. Inspect the decrypted HTTP bodies to verify the exact payloads leaving your machine.

## Contact

Questions or findings: hello@fiche.ink
