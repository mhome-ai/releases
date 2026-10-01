#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
source "$HERE/lib.sh"

version="${RELEASE_TAG:?}"
if [[ "$version" == t[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]-[0-9][0-9] ]]; then
  PRODUCT_SOURCE_MODE=attempt
  PRODUCT_SOURCE_TAG="$version"
  PRODUCT_VERSION="${version#t}"
elif [[ "$version" =~ ^v?[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  fail "compose source is a tYYYYMMDD-NN snapshot, not a version tag"
else
  read_product_tag "$RELEASE_TAG"
  PRODUCT_VERSION="${PRODUCT_VERSION:?}"
fi
require_mhome_clone baycat
require_cmd git aws
[ -n "${NATIVE_INSTALL_PUBLISH_ROLE_ARN:-}" ] || fail "Missing org variable NATIVE_INSTALL_PUBLISH_ROLE_ARN"

cleanup() {
  cleanup_worktree || echo "::warning::release worktree cleanup failed for $WORK_ROOT"
}
trap cleanup EXIT

prepare_product_sources
compose="${BAYCAT_DIR}/docker/meow-compose.yml"
[ -f "$compose" ] || fail "missing $compose"
grep -q '/root/.meow' "$compose" || fail "compose file does not mount /root/.meow"

assume_aws_role "$NATIVE_INSTALL_PUBLISH_ROLE_ARN"
SOURCE_SHA="$BAYCAT_REVISION"
publish_immutable_s3 "$compose" "$INSTALL_DISTRIBUTION_BUCKET" \
  "docker/versioned/${SOURCE_SHA}/meow-compose.yml" "text/yaml; charset=utf-8"
aws s3 cp "$compose" "s3://${INSTALL_DISTRIBUTION_BUCKET}/docker/stable/meow-compose.yml" \
  --content-type "text/yaml; charset=utf-8" \
  --cache-control "no-cache,max-age=0"
echo "Published ${INSTALL_DISTRIBUTION_BASE_URL}/docker/stable/meow-compose.yml"
