# fiche

fiche is a Windows app that sits between Claude Code and Anthropic and folds old conversation turns into page images so long Claude Code sessions send fewer input tokens.

## Download

Windows installers are on the [Releases](https://github.com/fiche-ink/fiche/releases) page of this repository. During the open beta, the installer is unsigned.

## What is in this repository

Because fiche acts as a local proxy for your Claude Code traffic, this repository publishes the network-facing client source (`client/src`) for inspection:

- `client/src/proxy.js` — the local proxy that receives requests from Claude Code and forwards them to Anthropic
- `client/src/net.js` — the single module every fiche request goes through
- `client/src/engine.js` — loads the local compression engine and attaches its network handler via `setNet()`
- `client/src/claude.js` — the Claude Code settings writer
- `client/src/setup.js` — the installer and uninstaller (copies the app, makes shortcuts and the Installed apps entry; no network)
- `client/src/meter.js` — the savings meter
- Electron main and preload modules

The compression engine itself is not published in this repository. It ships inside the installed app as `engine/v0.mjs` (readable JavaScript, outside `app.asar`) and runs locally.

The engine has no network path of its own: `client/src/engine.js` hands it a `request` function via `setNet()`. The `engine/v0.mjs` file still contains one `fetch` call, which is only the default used when no client attached a handler (fiche's own Linux test rig); the app always replaces it before the first request. It does not import `http`, `https`, `net` or `tls`; its only imports are `fs`, `crypto`, `zlib`, `os` and the canvas library used for drawing pages. It imports only `fs`, `crypto`, `zlib`, `os` and the canvas renderer — no `http`, `https` or `net` — which you can check in `engine/v0.mjs` inside the installed app.

## Outbound destinations

fiche sends network traffic to two hosts, and nothing else:

- **`api.anthropic.com`** — your Claude Code requests after fiche compressed them, sent with your own Claude login headers exactly as Claude Code sent them. fiche does not store or forward those headers anywhere else.
- **`judge.fiche.ink`** — per-block numbers (length, line stats, character-class shares, entropy, counts) plus salted one-way IDs, and outcome signals (kind of event such as a re-read or failed Edit, tool name, time, and the same salted IDs). No text, code, or file paths are sent. Turning off **사용 통계 보내기** (Send usage stats) stops outcome signals; judge numbers are still sent while compression is on. The salt is fixed per install, so the same block from the same PC always gets the same ID; it cannot be matched across PCs or reversed.

## How to verify

You do not need to trust the summary above. You can inspect the code and live traffic yourself:

1. Read `client/src/net.js` and `client/src/proxy.js`.
2. Extract `app.asar` from the installed app and diff `src` against `client/src` at the same release tag:
   ```cmd
   npx @electron/asar extract "%LOCALAPPDATA%\Programs\fiche\resources\app.asar" fiche-src
   ```
3. Check **기록** (History) → **보낸 기록** (Sent log) in the app to see every outbound request and expand the exact bodies sent to fiche servers.
4. Log TLS keys via `SSLKEYLOGFILE` and decrypt every outbound HTTP body in Wireshark.

Full step-by-step instructions are in [VERIFY.md](VERIFY.md).

## License

Source published for inspection; all rights reserved.

## Contact

hello@fiche.ink
