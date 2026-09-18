#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
source "$HERE/lib.sh"

ACTION="${1:-acquire}"
PREFIX="${2:-release-signing}"
KEYCHAIN="${RUNNER_TEMP:-/tmp}/${PREFIX}-${GITHUB_RUN_ID:-local}-${GITHUB_JOB:-job}.keychain-db"
CERTIFICATE="${RUNNER_TEMP:-/tmp}/${PREFIX}-${GITHUB_RUN_ID:-local}-${GITHUB_JOB:-job}.p12"
ORIGINAL="${RUNNER_TEMP:-/tmp}/${PREFIX}-${GITHUB_RUN_ID:-local}-${GITHUB_JOB:-job}.keychains"
PASSWORD_FILE="${RUNNER_TEMP:-/tmp}/${PREFIX}-${GITHUB_RUN_ID:-local}-${GITHUB_JOB:-job}.pass"

acquire() {
  [ -n "${APPLE_CSC_LINK:-${APPLE_CSC_LINK_B64:-}}" ] || fail "Missing APPLE_CSC_LINK"
  [ -n "${APPLE_CSC_KEY_PASSWORD:-}" ] || fail "Missing APPLE_CSC_KEY_PASSWORD"
  local b64="${APPLE_CSC_LINK:-$APPLE_CSC_LINK_B64}"
  local password
  password="$(openssl rand -hex 32)"
  umask 077
  mkdir -p "$(dirname "$KEYCHAIN")"
  security list-keychains -d user > "$ORIGINAL"
  printf '%s' "$b64" | tr -d '\r\n ' | openssl base64 -d -A > "$CERTIFICATE"
  printf '%s' "$password" > "$PASSWORD_FILE"
  security create-keychain -p "$password" "$KEYCHAIN"
  security set-keychain-settings -lut 21600 "$KEYCHAIN"
  security unlock-keychain -p "$password" "$KEYCHAIN"
  security import "$CERTIFICATE" \
    -k "$KEYCHAIN" \
    -P "$APPLE_CSC_KEY_PASSWORD" \
    -T /usr/bin/codesign \
    -T /usr/bin/security
  security set-key-partition-list \
    -S apple-tool:,apple:,codesign: \
    -s \
    -k "$password" \
    "$KEYCHAIN"
  local search_list=("$KEYCHAIN") entry
  while IFS= read -r entry; do
    entry="${entry#*\"}"
    entry="${entry%\"*}"
    [ -n "$entry" ] && search_list+=("$entry")
  done < "$ORIGINAL"
  security list-keychains -d user -s "${search_list[@]}"
}

release_keychain() {
  if [ -s "$ORIGINAL" ]; then
    local search_list=() entry
    while IFS= read -r entry; do
      entry="${entry#*\"}"
      entry="${entry%\"*}"
      [ -n "$entry" ] && search_list+=("$entry")
    done < "$ORIGINAL"
    [ "${#search_list[@]}" -eq 0 ] || security list-keychains -d user -s "${search_list[@]}"
  fi
  [ ! -f "$KEYCHAIN" ] || security delete-keychain "$KEYCHAIN"
  rm -f "$CERTIFICATE" "$ORIGINAL" "$PASSWORD_FILE"
}

case "$ACTION" in
  acquire) acquire ;;
  release) release_keychain ;;
  *) fail "usage: macos-signing-keychain.sh acquire|release [prefix]" ;;
esac
