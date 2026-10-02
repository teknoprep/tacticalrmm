#!/usr/bin/env bash
# Restart the pi bridge ONLY when nothing is working on a ticket/device.
#
# Why this exists: twice on 2026-09-27 a bridge restart was run while a chat was mid-task,
# because /pi/busy and /pi/live report "idle" BETWEEN tool steps of a run that is very much
# alive. On TICKET/60427 that paused a FusionPBX job; on TICKET/61884 it cut off a
# PowerShell command three seconds in and the result was never recorded.
#
# The bridge's own POST /pi/restart refuses when activeRuns > 0 || activeSessions > 0 - too
# strict (an open, idle window counts as a session), so this checks what actually matters:
#   * an agent run in flight (/pi/busy active_runs), or
#   * tool/judge/prompt activity in the log within the last WINDOW seconds.
#
# Usage:  bridge-restart.sh [--force] [--window 300]
# Exit:   0 restarted and healthy · 3 refused because work is in flight · 1 restart failed
set -uo pipefail
WINDOW=300
FORCE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --force) FORCE=1 ;;
    --window) WINDOW="$2"; shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

LOG="${PI_BRIDGE_LOG:-/var/log/pi-trmm-bridge.log}"
read_log() { sudo -n cat "$LOG" 2>/dev/null || cat "$LOG" 2>/dev/null || true; }

busy="$(curl -s --max-time 5 http://127.0.0.1:8787/pi/busy || true)"
runs="$(printf '%s' "$busy" | sed -n 's/.*"active_runs":\([0-9]*\).*/\1/p')"
runs="${runs:-0}"

since="$(date -u -d "-${WINDOW} seconds" +%Y-%m-%dT%H:%M:%S 2>/dev/null || date -u -v-"${WINDOW}"S +%Y-%m-%dT%H:%M:%S)"
recent="$(read_log | awk -v t="$since" '$1 >= t' | grep -cE 'tool>|judge |lazy |prompt ' || true)"

echo "active_runs=$runs   tool/judge events in the last ${WINDOW}s: $recent"
if [ "$FORCE" -eq 0 ] && { [ "$runs" -gt 0 ] || [ "$recent" -gt 0 ]; }; then
  echo
  echo "REFUSING to restart: work is in flight."
  echo "A chat is mid-task (the busy/idle flags read as idle BETWEEN tool steps, which is how"
  echo "TICKET/60427 and TICKET/61884 got cut off). Wait for it to finish, or pass --force if"
  echo "you have checked and accept interrupting it."
  read_log | awk -v t="$since" '$1 >= t' | grep -E 'tool>|judge ' | tail -5 | cut -c1-160
  exit 3
fi

echo "restarting pi-trmm-bridge..."
sudo systemctl restart pi-trmm-bridge || exit 1
sleep 5
if systemctl is-active --quiet pi-trmm-bridge && curl -s --max-time 5 http://127.0.0.1:8787/pi/health | grep -q '"ok":true'; then
  echo "restarted and healthy: $(curl -s --max-time 5 http://127.0.0.1:8787/pi/health)"
  exit 0
fi
echo "RESTART FAILED - check: sudo journalctl -u pi-trmm-bridge -n 50" >&2
exit 1
