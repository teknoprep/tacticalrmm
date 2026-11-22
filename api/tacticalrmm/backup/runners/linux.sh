#!/usr/bin/env bash
# RMM backup runner — Linux. Dispatched by the RMM backup module; edit it in the source tree
# (backup/runners/linux.sh), not in the Script Manager: the module overwrites the hidden script.
#
# Input (env, set by the dispatcher): RMM_BACKUP_API, RMM_BACKUP_TOKEN (one run, expires).
# Everything else (paths, destination, repo password) is fetched with that token, so nothing
# secret is in the script body, its arguments, or the TRMM audit log.
# Needs: bash, curl or wget, base64, sha256sum; bzip2 or python3 (restic download); unzip or
# python3 (rclone, only for SMB/FTP/SFTP); mount.nfs for NFS.
set -uo pipefail
umask 077

API="${RMM_BACKUP_API:-}"
TOKEN="${RMM_BACKUP_TOKEN:-}"
if [ -z "$API" ] || [ -z "$TOKEN" ]; then echo "RMM_BACKUP_API / RMM_BACKUP_TOKEN not set"; exit 2; fi

BASE=/var/lib/rmm-backup
BIN="$BASE/bin"
mkdir -p "$BIN" "$BASE/cache" "$BASE/work" && chmod 700 "$BASE"
# one log per runner process: a second job queued behind the host lock must not write into the
# log of the run that holds it (and old logs of killed runners are swept)
find "$BASE/work" -maxdepth 1 -name 'run-*.log' -mmin +1440 -delete 2>/dev/null || true
LOG="$BASE/work/run-$$.log"
: > "$LOG"
T0=$(date +%s)

log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" | tee -a "$LOG"; }

# ---------------------------------------------------------------- HTTP
http_get() { # url -> stdout
  if command -v curl >/dev/null; then curl -fsSL --retry 3 -H "X-Backup-Token: $TOKEN" "$1"
  else wget -qO- --header="X-Backup-Token: $TOKEN" "$1"; fi
}
http_download() { # url file
  if command -v curl >/dev/null; then curl -fsSL --retry 3 -o "$2" "$1"
  else wget -qO "$2" "$1"; fi
}
http_post_json() { # url body
  if command -v curl >/dev/null; then
    curl -fsS --retry 3 -H "X-Backup-Token: $TOKEN" -H "Content-Type: application/json" -d "$2" "$1" >/dev/null
  else
    wget -qO- --header="X-Backup-Token: $TOKEN" --header="Content-Type: application/json" --post-data="$2" "$1" >/dev/null
  fi
}
json_str() {
  local s
  s=$(printf '%s' "$1" | tr -d '\000-\010\013\014\016-\037')
  s=${s//\\/\\\\}; s=${s//\"/\\\"}; s=${s//$'\n'/\\n}; s=${s//$'\r'/\\r}; s=${s//$'\t'/\\t}
  printf '"%s"' "$s"
}
num() { case "$1" in ''|*[!0-9]*) echo 0 ;; *) echo "$1" ;; esac; }

REPORTED=0
report_done() { # status message
  local status="$1" msg="$2" dur=$(( $(date +%s) - T0 ))
  log "result: $status — $msg"
  local body
  body="{\"phase\":\"done\",\"status\":$(json_str "$status"),\"message\":$(json_str "$msg"),"
  body+="\"bytes_added\":$(num "${S_ADDED:-0}"),\"total_bytes\":$(num "${S_TOTAL:-0}"),"
  body+="\"files_new\":$(num "${S_FILES_NEW:-0}"),\"snapshots\":$(num "${S_SNAPS:-0}"),"
  body+="\"snapshot_id\":$(json_str "${S_SNAP:-}"),\"duration_seconds\":$dur,"
  body+="\"log\":$(json_str "$(tail -n 300 "$LOG")")}"
  http_post_json "$API/backup/agent/report/" "$body" || echo "could not post the result to $API"
  REPORTED=1
}
fail() { report_done error "$1"; exit 1; }

cleanup() {
  [ "$REPORTED" = 1 ] || report_done error "runner exited unexpectedly (see log)"
  if [ -n "${NFS_MNT:-}" ] && mountpoint -q "$NFS_MNT"; then umount "$NFS_MNT" || umount -l "$NFS_MNT"; fi
  rm -f "$BASE/work/paths" "$BASE/work/excludes" "$BASE/work/backup.json" "$LOG"
}
trap cleanup EXIT

# one runner at a time per host: a second job waits (up to 2h) instead of failing
exec 9>"$BASE/lock"
if command -v flock >/dev/null && ! flock -n 9; then
  http_post_json "$API/backup/agent/report/" \
    '{"phase":"start","message":"waiting for another backup run on this host"}' || true
  if ! flock -w 7200 9; then
    REPORTED=1
    http_post_json "$API/backup/agent/report/" \
      '{"phase":"done","status":"error","message":"another backup run held the host lock for over 2h"}'
    exit 1
  fi
fi

# ---------------------------------------------------------------- job document
DOC=$(http_get "$API/backup/agent/job/?as=env" 2>>"$LOG") || fail "could not fetch the job from $API (expired token or API error — see log)"
while IFS= read -r line; do
  k=${line%%=*}; v=${line#*=}
  [[ $k =~ ^[A-Z0-9_]+$ ]] || continue
  printf -v "J_$k" '%s' "$(printf '%s' "$v" | base64 -d)"
done <<< "$DOC"
unset DOC
http_post_json "$API/backup/agent/report/" '{"phase":"start","message":"running"}' || true
log "job '$J_JOB' run $J_RUN_ID on $J_HOST -> $J_D_PROVIDER"

# ---------------------------------------------------------------- engines (pinned + verified)
case "$(uname -m)" in
  x86_64|amd64) ARCH=amd64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *) fail "unsupported CPU architecture $(uname -m)" ;;
esac

verify() { # file sha
  local got; got=$(sha256sum "$1" | cut -d' ' -f1)
  [ "$got" = "$2" ] || { log "checksum mismatch for $1: $got"; return 1; }
}

RESTIC="$BIN/restic-$J_RESTIC_VERSION"
if [ ! -x "$RESTIC" ]; then
  log "installing restic $J_RESTIC_VERSION"
  sha_var="J_SHA_RESTIC_LINUX_$(echo "$ARCH" | tr a-z A-Z)"
  tmp="$BASE/work/restic.bz2"
  http_download "https://github.com/restic/restic/releases/download/v$J_RESTIC_VERSION/restic_${J_RESTIC_VERSION}_linux_$ARCH.bz2" "$tmp" \
    || fail "restic download failed"
  verify "$tmp" "${!sha_var}" || fail "restic download failed its checksum"
  if command -v bzip2 >/dev/null; then bzip2 -dc "$tmp" > "$RESTIC.new"
  elif command -v python3 >/dev/null; then python3 -c 'import bz2,sys; sys.stdout.buffer.write(bz2.open(sys.argv[1]).read())' "$tmp" > "$RESTIC.new"
  else fail "need bzip2 or python3 to unpack restic"; fi
  chmod 755 "$RESTIC.new" && mv "$RESTIC.new" "$RESTIC" && rm -f "$tmp"
fi

RCLONE="$BIN/rclone-$J_RCLONE_VERSION"
need_rclone() {
  [ -x "$RCLONE" ] && return 0
  log "installing rclone $J_RCLONE_VERSION"
  local sha_var="J_SHA_RCLONE_LINUX_$(echo "$ARCH" | tr a-z A-Z)" tmp="$BASE/work/rclone.zip"
  http_download "https://downloads.rclone.org/v$J_RCLONE_VERSION/rclone-v$J_RCLONE_VERSION-linux-$ARCH.zip" "$tmp" \
    || fail "rclone download failed"
  verify "$tmp" "${!sha_var}" || fail "rclone download failed its checksum"
  local member="rclone-v$J_RCLONE_VERSION-linux-$ARCH/rclone"
  if command -v unzip >/dev/null; then unzip -p "$tmp" "$member" > "$RCLONE.new"
  elif command -v python3 >/dev/null; then python3 -c 'import zipfile,sys; sys.stdout.buffer.write(zipfile.ZipFile(sys.argv[1]).read(sys.argv[2]))' "$tmp" "$member" > "$RCLONE.new"
  else fail "need unzip or python3 to unpack rclone"; fi
  chmod 755 "$RCLONE.new" && mv "$RCLONE.new" "$RCLONE" && rm -f "$tmp"
}

# ---------------------------------------------------------------- repository
join_path() { local out="" p; for p in "$@"; do p=${p#/}; p=${p%/}; [ -n "$p" ] && out="${out:+$out/}$p"; done; printf '%s' "$out"; }

export RESTIC_PASSWORD="$J_REPO_PASSWORD"
export RESTIC_CACHE_DIR="$BASE/cache"
RESTIC_OPTS=()

rclone_remote() { # type
  need_rclone
  : > "$BASE/work/rclone.conf"   # empty: everything comes from RCLONE_CONFIG_RMMB_* (silences "not found")
  export RCLONE_CONFIG="$BASE/work/rclone.conf"
  export RCLONE_CONFIG_RMMB_TYPE="$1"
  export RCLONE_CONFIG_RMMB_HOST="$J_D_HOST"
  [ "${J_D_PORT:-0}" != 0 ] && export RCLONE_CONFIG_RMMB_PORT="$J_D_PORT"
  local user="$J_D_USERNAME"
  if [ "$1" = smb ] && [[ $user == *\\* ]]; then
    export RCLONE_CONFIG_RMMB_DOMAIN="${user%%\\*}"; user="${user#*\\}"
  fi
  [ -n "$user" ] && export RCLONE_CONFIG_RMMB_USER="$user"
  if [ -n "$J_D_SECRET" ]; then
    RCLONE_CONFIG_RMMB_PASS=$(printf '%s' "$J_D_SECRET" | "$RCLONE" obscure -) || fail "rclone obscure failed"
    export RCLONE_CONFIG_RMMB_PASS
  fi
  if [ "$1" = ftp ] && [ "$J_D_TLS" = 1 ]; then export RCLONE_CONFIG_RMMB_EXPLICIT_TLS=true; fi
  RESTIC_OPTS+=(-o "rclone.program=$RCLONE")
}

case "$J_D_PROVIDER" in
  s3)
    ep="$J_D_ENDPOINT"
    [ -n "$ep" ] || ep="https://s3.${J_D_REGION:-us-east-1}.amazonaws.com"
    export AWS_ACCESS_KEY_ID="$J_D_USERNAME" AWS_SECRET_ACCESS_KEY="$J_D_SECRET"
    export AWS_DEFAULT_REGION="${J_D_REGION:-us-east-1}"
    export RESTIC_REPOSITORY="s3:${ep%/}/$(join_path "$J_D_SHARE" "$J_D_PATH" "$J_REPO_PATH")"
    ;;
  smb)  rclone_remote smb;  export RESTIC_REPOSITORY="rclone:rmmb:$(join_path "$J_D_SHARE" "$J_D_PATH" "$J_REPO_PATH")" ;;
  ftp)  rclone_remote ftp;  export RESTIC_REPOSITORY="rclone:rmmb:$(join_path "$J_D_SHARE" "$J_D_PATH" "$J_REPO_PATH")" ;;
  sftp) rclone_remote sftp; export RESTIC_REPOSITORY="rclone:rmmb:$(join_path "$J_D_SHARE" "$J_D_PATH" "$J_REPO_PATH")" ;;
  nfs)
    command -v mount.nfs >/dev/null || fail "NFS location, but mount.nfs is not installed (nfs-common / nfs-utils)"
    NFS_MNT="$BASE/mnt/$J_RUN_ID"; mkdir -p "$NFS_MNT"
    mount -t nfs -o soft,timeo=600,retrans=3 "$J_D_HOST:/${J_D_SHARE#/}" "$NFS_MNT" 2>>"$LOG" || fail "NFS mount of $J_D_HOST:$J_D_SHARE failed"
    export RESTIC_REPOSITORY="$NFS_MNT/$(join_path "$J_D_PATH" "$J_REPO_PATH")"
    mkdir -p "$RESTIC_REPOSITORY"
    ;;
  local)
    export RESTIC_REPOSITORY="/$(join_path "$J_D_PATH" "$J_REPO_PATH")"
    mkdir -p "$RESTIC_REPOSITORY"
    ;;
  *) fail "unknown destination type '$J_D_PROVIDER'" ;;
esac
unset J_D_SECRET J_REPO_PASSWORD
log "repository: ${RESTIC_REPOSITORY%%@*}"

r() { "$RESTIC" ${RESTIC_OPTS[@]+"${RESTIC_OPTS[@]}"} "$@"; }

if ! r cat config >/dev/null 2>>"$LOG"; then
  log "no repository yet — initialising"
  if ! r init >>"$LOG" 2>&1; then
    # behind restic, rclone only says "exit status 1"; ask rclone directly for the real cause
    # (e.g. 'failed to make FTP connection ... 530'). Lines naming pass/obscure never leave the host.
    why=""
    if [ -n "${RCLONE_CONFIG_RMMB_TYPE:-}" ]; then
      why=$("$RCLONE" lsd rmmb: --retries 1 --low-level-retries 1 --contimeout 20s --timeout 30s 2>&1 \
        | grep -E 'ERROR|CRITICAL|Failed|failed' | grep -viE 'pass(word)? *[=:]|obscure' | tail -n 1)
      [ -n "$why" ] && log "rclone probe: $why"
    fi
    [ -n "$why" ] || why=$(grep -E 'Fatal|error' "$LOG" | tail -n 1)
    why=$(printf '%s' "$why" | sed -E 's/^.*(CRITICAL|ERROR) *: *//; s/(Fatal: )+/Fatal: /' | cut -c1-300)
    hint=""
    [ "$J_D_PROVIDER" = ftp ] && [ "$J_D_TLS" = 1 ] && [[ $why == *530* ]] && hint=" (FTPS is on: the server may not support explicit TLS)"
    fail "could not open or create the repository$hint: ${why:-see log}"
  fi
fi
r unlock >>"$LOG" 2>&1 || true   # removes only stale locks

# ---------------------------------------------------------------- backup
: > "$BASE/work/paths"; : > "$BASE/work/excludes"
missing=()
while IFS= read -r p; do
  [ -z "$p" ] && continue
  if [ -e "$p" ]; then printf '%s\n' "$p" >> "$BASE/work/paths"; else missing+=("$p"); fi
done <<< "$J_PATHS"
printf '%s\n' "$J_EXCLUDES" | sed '/^$/d' > "$BASE/work/excludes"
[ -s "$BASE/work/paths" ] || fail "none of the job's paths exist on this host: $(echo "$J_PATHS" | tr '\n' ' ')"
[ ${#missing[@]} -gt 0 ] && log "skipping paths that do not exist: ${missing[*]}"

LIMIT=()
[ "$(num "$J_LIMIT_UPLOAD_KIB")" -gt 0 ] && LIMIT=(--limit-upload "$J_LIMIT_UPLOAD_KIB")

log "backup starting"
r backup --json --host "$J_HOST" --tag rmm-backup --tag "run-$J_RUN_ID" ${LIMIT[@]+"${LIMIT[@]}"} \
  --files-from "$BASE/work/paths" --exclude-file "$BASE/work/excludes" \
  > "$BASE/work/backup.json" 2>>"$LOG"
rc=$?
summary=$(grep '"message_type":"summary"' "$BASE/work/backup.json" | tail -n 1)
field() { printf '%s' "$summary" | sed -n "s/.*\"$1\":\"\{0,1\}\([^,\"}]*\).*/\1/p"; }
# data_added_packed = what the repository actually grew by (after compression); data_added also
# counts tree metadata uncompressed, so on a first run it exceeds the bytes processed
S_ADDED=$(field data_added_packed); [ -n "$S_ADDED" ] || S_ADDED=$(field data_added)
S_TOTAL=$(field total_bytes_processed)
S_FILES_NEW=$(field files_new); S_SNAP=$(field snapshot_id); S_SNAP=${S_SNAP:0:8}
grep '"message_type":"error"' "$BASE/work/backup.json" | head -n 20 >> "$LOG"

STATUS=ok; MSG="snapshot ${S_SNAP:-?}"
case $rc in
  0) ;;
  3) STATUS=warn; MSG="snapshot ${S_SNAP:-?}, but some files could not be read (see log)" ;;
  *) fail "restic backup failed (exit $rc) — see log" ;;
esac
[ ${#missing[@]} -gt 0 ] && { STATUS=warn; MSG="$MSG; missing paths: ${missing[*]}"; }

# ---------------------------------------------------------------- retention + validation
FORGET=(forget --host "$J_HOST" --keep-daily "$J_KEEP_DAILY" --keep-weekly "$J_KEEP_WEEKLY" --keep-monthly "$J_KEEP_MONTHLY")
[ "$J_PRUNE" = 1 ] && FORGET+=(--prune)
log "retention: ${FORGET[*]}"
if ! r "${FORGET[@]}" >>"$LOG" 2>&1; then STATUS=warn; MSG="$MSG; retention failed"; fi

CHECK=(check)
[ -n "$J_CHECK_SUBSET" ] && CHECK+=("--read-data-subset=$J_CHECK_SUBSET")
log "validation: ${CHECK[*]}"
if ! r "${CHECK[@]}" >>"$LOG" 2>&1; then
  STATUS=error; MSG="$MSG; REPOSITORY CHECK FAILED — do not trust this repo until investigated"
else
  MSG="$MSG; check ok${J_CHECK_SUBSET:+ (read $J_CHECK_SUBSET of data)}"
fi

S_SNAPS=$(r snapshots --host "$J_HOST" --json 2>>"$LOG" | grep -o '"short_id"' | wc -l)
report_done "$STATUS" "$MSG"
[ "$STATUS" = error ] && exit 1
exit 0
