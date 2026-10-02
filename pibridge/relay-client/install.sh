#!/usr/bin/env bash
# Install / UPDATE the rmm-relay pi extension (Linux / macOS).
#   curl -fsSL https://api.blueuc.com/pi/relay/v1/client/install.sh | bash
# Safe to re-run at any time: it replaces the extension in place, keeps your sign-in
# (~/.pi/agent/rmm-relay.json is NOT touched) and backs up whatever it replaces.
# After it finishes: restart pi (your sign-in is kept), then check with /rmm-status.
set -euo pipefail
BASE="${PI_RMM_RELAY_URL:-https://api.blueuc.com/pi/relay/v1}"
BASE="${BASE%/}"
AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
DIR="$AGENT_DIR/extensions/rmm-relay"
TARGET="$DIR/index.ts"
mkdir -p "$DIR"

# --- repair a known-bad third-party manifest --------------------------------
# The npm package `remote-pi` declares pi's HOST-PROVIDED modules
# (@earendil-works/pi-coding-agent, pi-tui, typebox, ...) as runtime *dependencies*, so npm
# installs duplicate copies of pi itself. pi 0.99+ prints:
#
#   Extension issues: ... must be declared in peerDependencies with a "*" range ...
#   Installed copies can bypass the extension loader and create duplicate runtime modules.
#
# That is a real hazard (two copies of pi's classes/registries in one process), and the
# package is still 0.7.0 upstream with the same manifest, so we fix it in place: declare them
# as peerDependencies exactly as pi asks, and move the duplicate copies out of the way. The
# package now resolves them from pi's host modules, which is the supported path.
# Idempotent: a manifest that is already correct is left alone, and nothing here is fatal.
repair_remote_pi() {
  local pkg="$AGENT_DIR/npm/node_modules/remote-pi/package.json"
  [ -f "$pkg" ] || return 0
  if ! command -v python3 >/dev/null 2>&1; then
    echo "rmm-relay: note: python3 not found, skipping the remote-pi manifest repair"
    return 0
  fi
  python3 - "$pkg" "$AGENT_DIR/npm/node_modules" <<'PY' || echo "rmm-relay: note: remote-pi repair skipped (unexpected package.json)"
import datetime, json, os, shutil, sys

pkg, nm = sys.argv[1], sys.argv[2]
HOST = ("@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "@earendil-works/pi-ai",
        "@earendil-works/pi-agent-core", "typebox")
try:
    with open(pkg, encoding="utf-8") as fh:
        data = json.load(fh)
except Exception as exc:  # unreadable/not JSON: leave it exactly as it was
    print(f"rmm-relay: note: could not read remote-pi/package.json ({exc}) - left untouched")
    sys.exit(0)

deps = data.get("dependencies") or {}
bad = [k for k in HOST if k in deps]
if not bad:
    sys.exit(0)  # already correct (or a future release fixed it): nothing to do

stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
shutil.copy2(pkg, f"{pkg}.bak-{stamp}")
for k in bad:
    deps.pop(k, None)
data["dependencies"] = deps
peers = data.get("peerDependencies") or {}
for k in HOST:
    peers[k] = "*"
data["peerDependencies"] = peers
with open(pkg, "w", encoding="utf-8") as fh:
    json.dump(data, fh, indent=2, ensure_ascii=False)
    fh.write("\n")
print("rmm-relay: repaired remote-pi manifest -> peerDependencies:", ", ".join(bad))

aside = os.path.join(nm, f".pi-host-dupes-{stamp}")
moved = []
for name in ("@earendil-works", "typebox"):
    src = os.path.join(nm, name)
    if os.path.exists(src):
        os.makedirs(aside, exist_ok=True)
        shutil.move(src, os.path.join(aside, name))
        moved.append(name)
if moved:
    print(f"rmm-relay: moved duplicate pi modules aside -> {aside}")
    print("rmm-relay: (they are re-created by any later `pi install`; re-run this script if the warning returns)")
PY
}
repair_remote_pi

# --- the extension itself ---------------------------------------------------
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT
if ! curl -fsSL "$BASE/client/index.ts" -o "$TMP"; then
  echo "rmm-relay: download failed from $BASE/client/index.ts" >&2
  exit 1
fi
grep -q "rmm-relay - use your RMM" "$TMP" || { echo "rmm-relay: download did not look like the rmm-relay extension" >&2; exit 1; }

VERSION="$(sed -n 's/^const CLIENT_VERSION = "\([^"]*\)".*/\1/p' "$TMP" | head -1)"
PROTOCOL="$(sed -n 's/^const PROTOCOL = \([0-9]*\).*/\1/p' "$TMP" | head -1)"
if [ -z "$VERSION" ]; then echo "rmm-relay: could not read the version from the download" >&2; exit 1; fi

if [ -f "$TARGET" ]; then
  OLD="$(sed -n 's/^const CLIENT_VERSION = "\([^"]*\)".*/\1/p' "$TARGET" | head -1)"
  if [ "$OLD" = "$VERSION" ] && [ "${PI_RMM_RELAY_FORCE:-0}" != "1" ]; then
    echo "rmm-relay already up to date (v$VERSION, protocol $PROTOCOL) -> $TARGET"
    echo "(set PI_RMM_RELAY_FORCE=1 to reinstall anyway)"
    echo "Next: restart pi if it is running. Check with /rmm-status."
    exit 0
  fi
  cp -a "$TARGET" "$TARGET.bak-$(date +%Y%m%dT%H%M%SZ)"
  [ -n "$OLD" ] && echo "rmm-relay: updating v$OLD -> v$VERSION"
fi

mv "$TMP" "$TARGET"
trap - EXIT
echo "Installed rmm-relay v$VERSION (protocol $PROTOCOL) -> $TARGET"
if ! command -v pi >/dev/null 2>&1; then
  echo
  echo "NOTE: the 'pi' command was not found on your PATH."
  echo "      Install Node.js 22.19+ (https://nodejs.org) then:"
  echo "        npm install -g --ignore-scripts @earendil-works/pi-coding-agent"
fi
echo "Next: restart pi. Your sign-in is kept (config: ~/.pi/agent/rmm-relay.json)."
echo "      If asked to sign in:  /rmm-login   then  /group <it|coding>"
echo "      Check what you are running with:  /rmm-status"
