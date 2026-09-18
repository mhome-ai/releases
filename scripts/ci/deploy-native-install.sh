#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
source "$HERE/lib.sh"

version="${RELEASE_TAG:?}"
if [[ "$version" == v* ]]; then
  version="${version#v}"
fi
if [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  PRODUCT_VERSION="$version"
else
  read_product_tag "$RELEASE_TAG"
  PRODUCT_VERSION="${PRODUCT_VERSION:?}"
fi
require_mhome_clone baycat
require_cmd git node aws
[ -n "${NATIVE_INSTALL_SCRIPT_BUCKET:-}" ] || fail "Missing NATIVE_INSTALL_SCRIPT_BUCKET"
[ -n "${NATIVE_INSTALL_PUBLISH_ROLE_ARN:-}" ] || fail "Missing NATIVE_INSTALL_PUBLISH_ROLE_ARN"

cleanup() { cleanup_worktree; }
trap cleanup EXIT

prepare_product_sources --baycat-version-mode match
cd "$BAYCAT_DIR"
out="${WORK_ROOT}/install-scripts"
mkdir -p "$out"
node scripts/release/native/render-install-meow.js \
  --template scripts/release/install-meow.sh \
  --output "$out/meow.sh"
node scripts/release/native/render-install-meow-windows.js "$out/meow.ps1"
bash -n "$out/meow.sh"
assume_aws_role "$NATIVE_INSTALL_PUBLISH_ROLE_ARN"
SOURCE_SHA="$BAYCAT_REVISION"
prefix="s3://${NATIVE_INSTALL_SCRIPT_BUCKET}/install"
publish_immutable_s3 "$out/meow.sh" "$NATIVE_INSTALL_SCRIPT_BUCKET" \
  "install/versioned/${SOURCE_SHA}/meow.sh" "text/x-shellscript; charset=utf-8"
aws s3 cp "$out/meow.sh" "$prefix/stable/meow.sh" \
  --content-type "text/x-shellscript; charset=utf-8" \
  --cache-control "no-cache,max-age=0"
publish_immutable_s3 "$out/meow.ps1" "$NATIVE_INSTALL_SCRIPT_BUCKET" \
  "install/versioned/${SOURCE_SHA}/meow.ps1" "text/plain; charset=utf-8"
aws s3 cp "$out/meow.ps1" "$prefix/stable/meow.ps1" \
  --content-type "text/plain; charset=utf-8" \
  --cache-control "no-cache,max-age=0"
