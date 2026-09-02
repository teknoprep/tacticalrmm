#!/bin/bash
# Fix for pi-coding-agent <= 0.84.3 / its bundled @earendil-works/pi-ai (upstream bug):
#
#   session.compact() -> completeSummarization() always sends toolChoice:"none",
#   and the openai-completions driver attaches tool_choice to the request even when
#   no tools are specified (summarization sends none / an empty list). OpenAI-compatible
#   servers that validate strictly - xAI (grok) among them - reject that with:
#
#     400 "Invalid request content: A tool_choice was set on the request but no
#          tools were specified."
#
#   ...which broke Compact / "Summarize & clear history" on grok sessions.
#
# IMPORTANT: pi-coding-agent ships TWO builds. `dist/bundle/` (minified, only used by
# the standalone CLI binary) and `dist/` + nested node_modules/@earendil-works/pi-ai
# (the library build - THIS is what SDK consumers like pi-trmm-bridge actually load).
# Both are patched here. Idempotent; safe to re-run. MUST be re-applied after any
# `npm install/update` of pi-coding-agent (check upstream first - a release after
# 0.84.3 may fix it properly, in which case this exits as a no-op).
#
# Usage: fix-toolchoice-no-tools.sh <path-containing-node_modules>
#   e.g. fix-toolchoice-no-tools.sh /opt/pi-trmm-bridge
#        fix-toolchoice-no-tools.sh /home/tactical/.local/share/pi-node/node-v22.22.3-linux-x64/lib
set -euo pipefail
ROOT="${1:-/opt/pi-trmm-bridge}"
PATCHED_ANY=0

# --- 1) Library build(s): unminified pi-ai drivers (the ones that matter). ---------
# NOTE: grok-4.x runs through the openai-RESPONSES driver, not just completions -
# patch every driver that attaches tool_choice unconditionally.
while IFS= read -r F; do
  if grep -q "params.tools.length > 0" "$F"; then
    echo "already patched: $F"
    PATCHED_ANY=1
    continue
  fi
  if ! grep -Eq 'if \(options\?\.toolChoice( !== undefined)?\) \{' "$F"; then
    echo "WARN: pattern not found in $F - layout changed, inspect by hand" >&2
    continue
  fi
  cp -a "$F" "$F.pre-toolchoice-patch"
  # completions form: if (options?.toolChoice) {
  perl -0pi -e 's/if \(options\?\.toolChoice\) \{\n(\s*)params\.tool_choice = options\.toolChoice;/if (options?.toolChoice && params.tools && params.tools.length > 0) {\n$1\/\/ PATCHED: tool_choice without tools is rejected by strict OpenAI-compatible servers (xAI\/grok).\n$1params.tool_choice = options.toolChoice;/' "$F"
  # responses form: if (options?.toolChoice !== undefined) {
  perl -0pi -e 's/if \(options\?\.toolChoice !== undefined\) \{\n(\s*)params\.tool_choice = options\.toolChoice;\n(\s*)\}/if (options?.toolChoice !== undefined && params.tools && params.tools.length > 0) {\n$1\/\/ PATCHED: tool_choice without tools is a 400 on strict OpenAI-compatible servers (xAI\/grok).\n$1params.tool_choice = options.toolChoice;\n$2}/' "$F"
  node --check "$F"
  echo "patched: $F"
  PATCHED_ANY=1
done < <(find "$ROOT/node_modules" -path "*pi-ai/dist/*" \( -name "openai-completions.js" -o -name "openai-responses.js" -o -name "azure-openai-responses.js" \) ! -name "*.map" 2>/dev/null)

# --- 2) CLI bundle (minified chunks; only the standalone `pi` binary uses these) ----
while IFS= read -r F; do
  if grep -q "params.tools.length>0&&(params.tool_choice" "$F"; then
    echo "already patched: $F"
    continue
  fi
  cp -a "$F" "$F.pre-toolchoice-patch"
  sed -i 's/options?.toolChoice\&\&(params.tool_choice=options.toolChoice)/options?.toolChoice\&\&params.tools\&\&params.tools.length>0\&\&(params.tool_choice=options.toolChoice)/' "$F"
  node --check "$F"
  echo "patched (bundle): $F"
done < <(grep -rl "options?.toolChoice&&(params.tool_choice=options.toolChoice)" \
  "$ROOT"/node_modules/@earendil-works/pi-coding-agent/dist/bundle/chunks/openai-completions-*.js 2>/dev/null || true)

[ "$PATCHED_ANY" = 1 ] || { echo "ERROR: no library driver found/patched under $ROOT" >&2; exit 1; }
echo done
