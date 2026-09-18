#!/usr/bin/env bash
set -euo pipefail

# usage: machine-lock.sh acquire|release <name>
# Holds a directory lock under ~/.mhome/locks so E2E and release jobs on the
# same Mac do not mutate ~/.mhome at the same time. Stale locks older than
# 12 hours are stolen.

ACTION="${1:-}"
NAME="${2:-}"
case "$ACTION" in acquire | release) ;; *)
  echo "usage: machine-lock.sh acquire|release <name>" >&2
  exit 2
  ;;
esac
[[ "$NAME" =~ ^[A-Za-z0-9._-]+$ ]] || {
  echo "invalid lock name: $NAME" >&2
  exit 2
}

LOCK_ROOT="${MHOME_ROOT:-$HOME/.mhome}/locks"
LOCK_DIR="$LOCK_ROOT/$NAME"
OWNER_FILE="$LOCK_DIR/owner"
STALE_SECONDS=$((12 * 60 * 60))

owner_record() {
  printf '%s %s %s %s\n' \
    "${GITHUB_RUN_ID:-local}" \
    "${GITHUB_JOB:-shell}" \
    "${GITHUB_RUN_ATTEMPT:-1}" \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}

lock_age_seconds() {
  local stamp
  if stamp="$(stat -f %m "$LOCK_DIR" 2>/dev/null)"; then
    printf '%s' "$(($(date +%s) - stamp))"
    return
  fi
  if stamp="$(stat -c %Y "$LOCK_DIR" 2>/dev/null)"; then
    printf '%s' "$(($(date +%s) - stamp))"
    return
  fi
  printf '%s' "0"
}

acquire() {
  mkdir -p "$LOCK_ROOT"
  while true; do
    if mkdir "$LOCK_DIR" 2>/dev/null; then
      owner_record >"$OWNER_FILE"
      echo "acquired $LOCK_DIR"
      return
    fi
    if [ -d "$LOCK_DIR" ]; then
      age="$(lock_age_seconds)"
      if [ "$age" -ge "$STALE_SECONDS" ]; then
        echo "stealing stale lock $LOCK_DIR (age ${age}s)" >&2
        rm -rf "$LOCK_DIR"
        continue
      fi
      echo "waiting for $LOCK_DIR ($(cat "$OWNER_FILE" 2>/dev/null || echo unknown))"
    fi
    sleep 15
  done
}

release_lock() {
  if [ ! -d "$LOCK_DIR" ]; then
    return
  fi
  if [ -f "$OWNER_FILE" ] && [ -n "${GITHUB_RUN_ID:-}" ]; then
    owner_run="$(awk '{print $1}' "$OWNER_FILE")"
    if [ "$owner_run" != "$GITHUB_RUN_ID" ]; then
      echo "not releasing $LOCK_DIR owned by ${owner_run:-unknown}"
      return
    fi
  fi
  rm -rf "$LOCK_DIR"
  echo "released $LOCK_DIR"
}

case "$ACTION" in
  acquire) acquire ;;
  release) release_lock ;;
esac
