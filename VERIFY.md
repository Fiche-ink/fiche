# Verifying fiche

fiche is a Windows app that sits between Claude Code and Anthropic and folds old conversation turns into page images so long Claude Code sessions send fewer input tokens.

Because a local proxy on that path sees your Claude Code traffic and login headers, this document lists every host fiche contacts, explains how the client source and local engine are structured, and shows four ways to verify what the installed app does on your machine.

## Where traffic goes

fiche sends requests to two destinations, and nothing else:

### 1. `api.anthropic.com`
Your Claude Code requests after fiche compressed them, sent with your own Claude login headers exactly as Claude Code sent them. fiche does not store or forward those headers anywhere else.

### 2. `judge.fiche.ink`
- **Judge numbers:** per-block numbers (length, line stats, character-class shares, entropy, counts) plus salted one-way IDs. The salt is fixed per install, so the same block from the same PC always gets the same ID; it cannot be matched across PCs or reversed.
- **Outcome signals:** the kind of event (such as a re-read or failed Edit), tool name, time, and the same salted IDs.
- **What is excluded:** no text, code, or file paths.
- **Settings control:** turning off **사용 통계 보내기** (Send usage stats) stops outcome signals. Judge numbers are still sent while compression is on.


## Published client source vs. local engine

The public repository at [github.com/fiche-ink/fiche](https://github.com/fiche-ink/fiche) contains the network-facing client source in `client/src`:

- `proxy.js` — the local proxy
- `net.js` — the single module every fiche request goes through
- `engine.js` — attaches the client network handler to the compression engine via `setNet()`
- `claude.js` — the Claude Code settings writer
- `setup.js` — the installer and uninstaller (copies the app, makes shortcuts and the Installed apps entry; no network)
- `meter.js` — the savings meter
- Electron main and preload modules

The compression engine is not published in the repository. It ships inside the installed app as `engine/v0.mjs` (readable JavaScript, outside `app.asar`) and runs locally.

The engine has no network path of its own: the client hands it a `request` function via `setNet()` (`client/src/engine.js`). If you open `engine/v0.mjs`, you will see one `fetch` call in the file. That `fetch` is only the default used when no client attached a handler (fiche's own Linux test rig); the app always replaces it before the first request. It does not import `http`, `https`, `net` or `tls`; its only imports are `fs`, `crypto`, `zlib`, `os` and the canvas library used for drawing pages. It imports only `fs`, `crypto`, `zlib`, `os` and the canvas renderer — no `http`, `https` or `net` — which you can check in `engine/v0.mjs` inside the installed app.

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
