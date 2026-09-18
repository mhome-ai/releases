#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
source "$HERE/lib.sh"

CHANNEL="${RELEASE_CHANNEL:?RELEASE_CHANNEL is required}"
case "$CHANNEL" in
  native|desktop|docker)
    read_product_tag "${RELEASE_TAG:?RELEASE_TAG is required}"
    [ "$PRODUCT_CHANNEL" = "$CHANNEL" ] || fail "$RELEASE_TAG is $PRODUCT_CHANNEL; this workflow is $CHANNEL"
    if [ -n "${WORK_SUFFIX:-}" ]; then
      [ "$PRODUCT_PLATFORM" = "$WORK_SUFFIX" ] || fail "$RELEASE_TAG is $PRODUCT_PLATFORM; this runner is $WORK_SUFFIX"
    fi
    bash "$HERE/${CHANNEL}-release.sh"
    ;;
  install)
    bash "$HERE/deploy-native-install.sh"
    ;;
  *) fail "unknown release channel: $CHANNEL" ;;
esac
