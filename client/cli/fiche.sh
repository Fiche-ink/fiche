#!/bin/sh
# fiche launcher (installed as <root>/bin/fiche, usually linked from ~/.local/bin/fiche).
#
# Symlinks on the launcher itself are followed, but path components are not: an install under
# .../fiche/current/bin keeps "current" in FICHE_HOME, so a launchd plist or systemd unit written
# from here still points at the right place after an upgrade.
set -e
self=$0
while [ -L "$self" ]; do
  target=$(readlink "$self")
  case "$target" in
    /*) self=$target ;;
    *) self=$(dirname "$self")/$target ;;
  esac
done
FICHE_HOME=$(cd "$(dirname "$self")/.." && pwd)
export FICHE_HOME
export FICHE_LAUNCHER="$FICHE_HOME/bin/fiche"

# A node that install.sh downloaded lives next to the version folders, not inside one, so it is
# shared by every installed version. dirname is textual, which keeps the "current" symlink intact.
up1=$(dirname "$FICHE_HOME")
up2=$(dirname "$up1")
node_bin=
for candidate in "$FICHE_HOME/node/bin/node" "$up1/node/bin/node" "$up2/node/bin/node"; do
  if [ -x "$candidate" ]; then node_bin=$candidate; break; fi
done
if [ -n "$node_bin" ]; then
  :
elif command -v node >/dev/null 2>&1; then
  node_bin=node
else
  echo "fiche: needs node 20 or newer, and none was found. Reinstall with https://fiche.ink/install.sh" >&2
  exit 1
fi
exec "$node_bin" "$FICHE_HOME/cli/fiche.js" "$@"
