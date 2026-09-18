#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
source "$HERE/lib.sh"

CHANNEL="${RELEASE_CHANNEL:?RELEASE_CHANNEL is required}"
case "$CHANNEL" in
  native) bash "$HERE/native-release.sh" ;;
  desktop) bash "$HERE/desktop-release.sh" ;;
  docker) bash "$HERE/docker-release.sh" ;;
  install) bash "$HERE/deploy-native-install.sh" ;;
  *) fail "unknown release channel: $CHANNEL" ;;
esac
