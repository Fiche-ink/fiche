#!/bin/sh
# fiche installer for macOS, Linux and WSL2.
#
#   curl -fsSL https://fiche.ink/install.sh | sh
#
# It downloads the CLI client for this machine, checks its SHA-256 against the release's
# SHA256SUMS, puts it in ~/.local/share/fiche, links ~/.local/bin/fiche, and starts the daemon at
# login (launchd, systemd --user, or a line in your shell rc file when there is no init to use).
# Nothing is signed by a certificate: the download is verified by hash instead, and the hashes are
# printed in the release notes so they can be checked by hand.
#
# Options (environment or flags):
#   FICHE_PREFIX     install folder            (default ~/.local/share/fiche)
#   FICHE_BINDIR     where `fiche` is linked   (default ~/.local/bin)
#   FICHE_VERSION    release tag, e.g. v1.0.1  (default: the latest release)
#   FICHE_BASE_URL   where to fetch from       (default: the GitHub release)
#   FICHE_WINDOW_VERSION  window app release tag (default below)
#   --no-service     do not start fiche at login
#   --no-start       do not start the daemon now
#   --no-window      do not install the window app (fiche ui then opens in the browser)
set -eu

REPO=${FICHE_REPO:-fiche-ink/fiche}
PREFIX=${FICHE_PREFIX:-$HOME/.local/share/fiche}
BINDIR=${FICHE_BINDIR:-$HOME/.local/bin}
NODE_MAJOR_MIN=20
NODE_SERIES=${FICHE_NODE_SERIES:-v22.x}
DO_SERVICE=1
DO_START=1
DO_WINDOW=1
WINDOW_TAG=${FICHE_WINDOW_VERSION:-window-v0.1.0}

for arg in "$@"; do
  case "$arg" in
    --no-service) DO_SERVICE=0 ;;
    --no-start) DO_START=0 ;;
    --no-window) DO_WINDOW=0 ;;
    --prefix=*) PREFIX=${arg#--prefix=} ;;
    --version=*) FICHE_VERSION=${arg#--version=} ;;
    -h|--help) sed -n '2,20p' "$0" 2>/dev/null || true; exit 0 ;;
    *) echo "fiche: unknown option $arg" >&2; exit 2 ;;
  esac
done

say() { printf '%s\n' "$*"; }
err() { printf 'fiche: %s\n' "$*" >&2; }
die() { err "$*"; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

# ---- download helper: curl or wget, whichever is there ----
if have curl; then
  fetch() { curl -fsSL "$1" -o "$2"; }
  fetch_out() { curl -fsSL "$1"; }
elif have wget; then
  fetch() { wget -qO "$2" "$1"; }
  fetch_out() { wget -qO- "$1"; }
else
  die "needs curl or wget"
fi

sha256_of() {
  if have sha256sum; then sha256sum "$1" | cut -d' ' -f1
  elif have shasum; then shasum -a 256 "$1" | cut -d' ' -f1
  elif have openssl; then openssl dgst -sha256 "$1" | sed 's/.*= //'
  else echo ""; fi
}

# ---- which build ----
os=$(uname -s)
machine=$(uname -m)
case "$os" in
  Darwin) plat=darwin ;;
  Linux) plat=linux ;;
  *) die "$os is not supported. Windows has its own app: https://fiche.ink" ;;
esac
case "$machine" in
  arm64|aarch64) arch=arm64 ;;
  x86_64|amd64) arch=x64 ;;
  *) die "$machine is not supported (needs x86_64 or arm64)" ;;
esac
if [ "$plat" = linux ]; then
  libc=gnu
  if ls /lib/ld-musl-* >/dev/null 2>&1 || ldd --version 2>&1 | grep -qi musl; then libc=musl; fi
  target="linux-$arch-$libc"
else
  target="darwin-$arch"
fi

is_wsl=0
if [ "$plat" = linux ] && { [ -n "${WSL_DISTRO_NAME:-}" ] || grep -qi microsoft /proc/sys/kernel/osrelease 2>/dev/null; }; then is_wsl=1; fi

asset="fiche-cli-$target.tar.gz"
if [ -n "${FICHE_BASE_URL:-}" ]; then base="$FICHE_BASE_URL"
elif [ -n "${FICHE_VERSION:-}" ]; then base="https://github.com/$REPO/releases/download/$FICHE_VERSION"
else base="https://github.com/$REPO/releases/latest/download"; fi

say "fiche: $target"

tmp=$(mktemp -d "${TMPDIR:-/tmp}/fiche-install.XXXXXX")
trap 'rm -rf "$tmp"' EXIT INT TERM

# ---- download and verify ----
say "fiche: downloading $asset"
fetch "$base/$asset" "$tmp/$asset" || die "could not download $base/$asset"
if fetch "$base/SHA256SUMS" "$tmp/SHA256SUMS" 2>/dev/null; then
  want=$(grep " $asset\$" "$tmp/SHA256SUMS" | cut -d' ' -f1 | head -1)
  got=$(sha256_of "$tmp/$asset")
  if [ -z "$want" ]; then err "SHA256SUMS has no line for $asset; skipping the check"
  elif [ -z "$got" ]; then err "no sha256 tool found; skipping the check"
  elif [ "$want" != "$got" ]; then die "checksum mismatch
  expected $want
  got      $got"
  else say "fiche: sha256 ok"; fi
else
  err "SHA256SUMS was not published with this release; skipping the check"
fi

tar xzf "$tmp/$asset" -C "$tmp" || die "could not unpack $asset"
[ -f "$tmp/fiche/package.json" ] || die "the archive does not look like a fiche build"
ver=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$tmp/fiche/package.json" | head -1)
[ -n "$ver" ] || ver=unknown

# ---- node ----
node_ok=0
if have node; then
  major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
  case "$major" in ''|*[!0-9]*) major=0 ;; esac
  if [ "$major" -ge "$NODE_MAJOR_MIN" ]; then node_ok=1; fi
fi
if [ "$node_ok" = 0 ] && [ -x "$PREFIX/node/bin/node" ]; then node_ok=1; fi
if [ "$node_ok" = 0 ]; then
  if [ "$plat" = linux ] && [ "${libc:-gnu}" = musl ]; then
    die "needs node $NODE_MAJOR_MIN or newer. There is no official musl build, so install it from your package manager first (for example: apk add nodejs)"
  fi
  say "fiche: no node $NODE_MAJOR_MIN+ found; downloading the official build (about 50 MB, used only by fiche)"
  nurl="https://nodejs.org/dist/latest-$NODE_SERIES"
  nfile=$(fetch_out "$nurl/SHASUMS256.txt" | grep -o "node-v[0-9.]*-$plat-$arch\.tar\.gz" | head -1) \
    || die "could not reach nodejs.org"
  [ -n "$nfile" ] || die "no official node build for $plat-$arch"
  nwant=$(fetch_out "$nurl/SHASUMS256.txt" | grep " $nfile\$" | cut -d' ' -f1 | head -1)
  fetch "$nurl/$nfile" "$tmp/$nfile" || die "could not download $nfile"
  ngot=$(sha256_of "$tmp/$nfile")
  if [ -n "$nwant" ] && [ -n "$ngot" ] && [ "$nwant" != "$ngot" ]; then die "node checksum mismatch"; fi
  mkdir -p "$tmp/node"
  tar xzf "$tmp/$nfile" -C "$tmp/node" --strip-components=1 || die "could not unpack node"
  mkdir -p "$PREFIX"
  rm -rf "$PREFIX/node.old"
  if [ -d "$PREFIX/node" ]; then mv "$PREFIX/node" "$PREFIX/node.old"; fi
  mv "$tmp/node" "$PREFIX/node"
  rm -rf "$PREFIX/node.old"
  say "fiche: node $(basename "$nfile" .tar.gz | sed 's/node-//;s/-.*//') installed in $PREFIX/node"
fi

# ---- stop a running copy, then install ----
if [ -x "$BINDIR/fiche" ]; then "$BINDIR/fiche" stop >/dev/null 2>&1 || true; fi
# An older install may have left a service pointing at a version folder that is about to go.
if [ -x "$BINDIR/fiche" ]; then had_service=$("$BINDIR/fiche" service status 2>/dev/null | grep -c ': on' || true); else had_service=0; fi

dest="$PREFIX/versions/$ver"
mkdir -p "$PREFIX/versions" "$BINDIR"
rm -rf "$dest"
mv "$tmp/fiche" "$dest"
ln -sfn "versions/$ver" "$PREFIX/current"
ln -sfn "$PREFIX/current/bin/fiche" "$BINDIR/fiche"
chmod +x "$dest/bin/fiche"

# ---- macOS without a certificate ----
# A tarball fetched with curl carries no quarantine flag, but if one is there (downloaded in a
# browser, say) the renderer will not load; and on Apple Silicon native code needs at least an
# ad-hoc signature. Both are fixed here, best effort, with the tools that come with macOS.
if [ "$plat" = darwin ]; then
  have xattr && xattr -dr com.apple.quarantine "$dest" 2>/dev/null || true
  if have codesign; then
    for f in "$dest"/node_modules/@napi-rs/canvas/*.node; do
      [ -f "$f" ] && codesign --force --sign - "$f" >/dev/null 2>&1 || true
    done
    [ -x "$PREFIX/node/bin/node" ] && codesign --force --sign - "$PREFIX/node/bin/node" >/dev/null 2>&1 || true
  fi
fi

# keep the last three versions
ls -1dt "$PREFIX"/versions/* 2>/dev/null | tail -n +4 | while read -r old; do rm -rf "$old"; done

say "fiche: installed $ver in $dest"

# ---- check it runs ----
# `fiche doctor` answers in the user's language, so its text is not matched here: it exits
# non-zero when node or the renderer cannot work, which is the whole question at this point.
# LC_ALL=C only keeps the output readable in this installer's own English.
if ! LC_ALL=C LANG=C "$BINDIR/fiche" doctor >"$tmp/doctor.txt" 2>&1; then
  cat "$tmp/doctor.txt" >&2
  die "this build does not run on this machine"
fi

# ---- the window app ----
# `fiche ui` shows the app screen in a window of its own (shell/ in the source, built with Tauri
# from the public repo). Optional: without it, `fiche ui` opens the same screen in the browser.
# Like the CLI it is not signed; fetched here rather than through a browser, it carries no
# quarantine flag (macOS) or mark of the web (Windows), so it opens without a warning.
win_ok=0
# Windows programs started from WSL read this shell's stdin, and with `curl ... | sh` that is the
# rest of this script: every one of them gets </dev/null.
win_cmd() { (cd /mnt/c 2>/dev/null && /mnt/c/Windows/System32/cmd.exe /c "$1" </dev/null 2>/dev/null | tr -d '\r'); }
install_window() {
  wbase=${FICHE_WINDOW_BASE_URL:-https://github.com/$REPO/releases/download/$WINDOW_TAG}
  if [ "$is_wsl" = 1 ]; then wasset=fiche-window-windows-x64.tar.gz
  elif [ "$plat" = darwin ]; then wasset=fiche-window-macos.zip
  elif [ "$libc" = gnu ]; then wasset="fiche-window-linux-$arch.tar.gz"
  else return 1; fi
  if [ "$plat" = linux ] && [ "$is_wsl" = 0 ]; then
    # It draws with the system's WebKitGTK; desktop installs have it, servers usually do not.
    { ldconfig -p 2>/dev/null || /sbin/ldconfig -p 2>/dev/null; } | grep -q 'libwebkit2gtk-4\.1\.so\.0' || {
      say "fiche: no window app here (it needs libwebkit2gtk-4.1); fiche ui opens in the browser"; return 1; }
  fi
  fetch "$wbase/$wasset" "$tmp/$wasset" && fetch "$wbase/SHA256SUMS" "$tmp/window.sums" || { err "could not download the window app"; return 1; }
  wwant=$(grep " $wasset\$" "$tmp/window.sums" | cut -d' ' -f1 | head -1)
  wgot=$(sha256_of "$tmp/$wasset")
  { [ -n "$wwant" ] && [ "$wwant" = "$wgot" ]; } || { err "window app checksum mismatch; skipped"; return 1; }

  if [ "$plat" = darwin ]; then
    rm -rf "$tmp/window" && mkdir -p "$tmp/window" "$HOME/Applications"
    ditto -x -k "$tmp/$wasset" "$tmp/window" && [ -d "$tmp/window/fiche.app" ] || return 1
    rm -rf "$HOME/Applications/fiche.app"
    mv "$tmp/window/fiche.app" "$HOME/Applications/fiche.app" || return 1
    xattr -dr com.apple.quarantine "$HOME/Applications/fiche.app" 2>/dev/null || true
    return 0
  fi

  mkdir -p "$PREFIX/shell"
  if [ "$is_wsl" = 1 ]; then
    # A Windows window for fiche inside WSL: it reaches the daemon through WSL's localhost forwarding.
    la=$(win_cmd 'echo %LOCALAPPDATA%'); ap=$(win_cmd 'echo %APPDATA%')
    { [ -n "$la" ] && [ -n "$ap" ] && have wslpath; } || return 1
    wdir="$(wslpath -u "$la")/Programs/fiche-wsl"
    mkdir -p "$wdir" && tar xzf "$tmp/$wasset" -C "$wdir" || { err "could not unpack the window app (is it open? close it and run the installer again)"; return 1; }
    printf '%s\n' "$wdir/fiche.exe" > "$PREFIX/shell/windows-exe"
    lnk="$(wslpath -u "$ap")/Microsoft/Windows/Start Menu/Programs/fiche (WSL).lnk"
    FW_TARGET=$(wslpath -w "$wdir/fiche.exe") FW_LNK=$(wslpath -w "$lnk") \
    FW_ARGS="--url-cmd wsl.exe -d ${WSL_DISTRO_NAME:-} -e $PREFIX/current/bin/fiche ui --url" WSLENV=FW_TARGET:FW_LNK:FW_ARGS \
      /mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe -NoProfile -NonInteractive -Command \
      '$s = (New-Object -ComObject WScript.Shell).CreateShortcut($env:FW_LNK); $s.TargetPath = $env:FW_TARGET; $s.Arguments = $env:FW_ARGS; $s.IconLocation = $env:FW_TARGET; $s.Save()' \
      </dev/null >/dev/null 2>&1 || err "could not add the Start menu shortcut"
    printf '%s\n%s\n' "$wdir" "$lnk" > "$PREFIX/shell/windows-files"
    return 0
  fi

  tar xzf "$tmp/$wasset" -C "$PREFIX/shell" && chmod +x "$PREFIX/shell/fiche" || return 1
  apps="$HOME/.local/share/applications"; icons="$HOME/.local/share/icons/hicolor/256x256/apps"
  mkdir -p "$apps" "$icons"
  [ -f "$PREFIX/shell/fiche.png" ] && cp "$PREFIX/shell/fiche.png" "$icons/fiche.png"
  cat > "$apps/fiche.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=fiche
Comment=Context compression for Claude Code
Exec="$PREFIX/shell/fiche" --url-cmd "$PREFIX/current/bin/fiche" ui --url
Icon=fiche
Terminal=false
Categories=Development;
DESKTOP
  return 0
}
if [ "$DO_WINDOW" = 1 ]; then
  if install_window; then win_ok=1; say "fiche: window app installed"; fi
fi

# The login item comes first: launchd and systemd start the daemon themselves, so starting one
# here as well would leave two copies fighting over the port.
if [ "$DO_SERVICE" = 1 ] || [ "${had_service:-0}" != 0 ]; then
  "$BINDIR/fiche" service install || err "could not set up start at login"
fi
# Quiet: the login item above usually started it already, and the next steps are printed below.
if [ "$DO_START" = 1 ]; then "$BINDIR/fiche" start --quiet || err "could not start the daemon"; fi

# Open the window so signing in is one click. Not over SSH: the screen is on the other end.
opened=0
if [ "$win_ok" = 1 ] && [ "$DO_START" = 1 ] && [ -z "${SSH_CONNECTION:-}" ]; then
  if [ "$plat" = darwin ] || [ "$is_wsl" = 1 ] || [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then
    "$BINDIR/fiche" ui </dev/null >/dev/null 2>&1 && opened=1 || true
  fi
fi

# ---- what to do next ----
say ""
case ":$PATH:" in
  *":$BINDIR:"*) ;;
  *) say "  $BINDIR is not on your PATH. Add it:"
     say "    echo 'export PATH=\"\$PATH:$BINDIR\"' >> ~/.profile"
     say "" ;;
esac
if [ "$opened" = 1 ]; then
  say "  fiche is open in its own window: sign in there to start compressing."
  say "  Open it again with: fiche ui"
  say ""
fi
say "  fiche login     sign in (needed before anything is compressed)"
say "  fiche ui        the app screen"
say "  fiche status    what it is doing"
say "  fiche stats     what it saved"
if [ "$is_wsl" = 1 ]; then
  say ""
  say "  WSL2: this install handles Claude Code inside WSL. Claude Code on the Windows side"
  say "  is a separate install - get the Windows app from https://fiche.ink"
fi
