#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
source "$HERE/lib.sh"
read_product_tag "${RELEASE_TAG:?RELEASE_TAG is required}"
[ "$PRODUCT_CHANNEL" = plugin-docker ] || fail "Expected a Plugin appliance release tag"
require_mhome_clone plugin
require_mhome_clone releases
require_cmd git node npm gh curl minisign python3 aws docker
repo="${GITHUB_REPOSITORY:-mhome-ai/releases}"
[ -n "${GH_TOKEN:-}" ] || fail "GH_TOKEN is required"
[ -n "${PLUGIN_PUBLISH_ROLE_ARN:-}" ] || fail "Missing PLUGIN_PUBLISH_ROLE_ARN"

cleanup() {
  if [ -n "${PLUGIN_DIR:-}" ]; then rm -f "$PLUGIN_DIR/build/plugin-catalog/catalog.key"; fi
  if [ "${SIGNING_KEYCHAIN:-}" = 1 ]; then bash "$CI_ROOT/macos-signing-keychain.sh" release plugin-native || true; fi
  cleanup_worktree || echo "::warning::Plugin source cleanup failed for $WORK_ROOT"
}
trap cleanup EXIT
prepared="$(mktemp)"
plugin_commit="$(read_product_source_commit plugin mhome-ai/plugin)"
node "$CI_ROOT/prepare-plugin-sources.js" --version "$PRODUCT_VERSION" --commit "$plugin_commit" --work-id "$WORK_ID" > "$prepared"
while IFS= read -r line; do
  case "$line" in
    plugin_dir=*) PLUGIN_DIR="${line#plugin_dir=}" ;;
    plugin_revision=*) PLUGIN_REVISION="${line#plugin_revision=}" ;;
  esac
done < "$prepared"
rm -f "$prepared"
cd "${PLUGIN_DIR:?plugin source is missing}"
npm ci --ignore-scripts
node "$CI_ROOT/verify-plugin-handoff.js" "${PLUGIN_HANDOFF:?Plugin build artifact is required}" "$PLUGIN_REVISION" "$(git -C "$RELEASES_DIR" rev-parse HEAD)" "$PRODUCT_RELEASE_TAG"
mkdir -p build/plugin-catalog build/native-plugin-assets "$PLUGIN_HANDOFF/assets"
cp -R "$PLUGIN_HANDOFF/assets/." build/native-plugin-assets/
assets_dir="$PWD/build/native-plugin-assets"
catalog_dir="$PWD/build/plugin-catalog"
printf '%s' "$GH_TOKEN" | docker login ghcr.io --username "${GITHUB_ACTOR:?}" --password-stdin
orchestrator_revision="$(git -C "$RELEASES_DIR" rev-parse HEAD)"

# A complete signed catalog is uploaded last. Its presence makes retries reuse
# exactly those bytes, even if a prior run stopped before stable promotion.
resume=false
exists=false
if gh release view "$PRODUCT_RELEASE_TAG" --repo "$repo" --json isDraft,assets > "$catalog_dir/release.json" 2> "$catalog_dir/release.error"; then
  exists=true
  resume="$(node -e 'const c=require(process.argv[1]); console.log(["catalog.json","catalog.json.minisig"].every(n=>c.assets.some(a=>a.name===n)))' "$catalog_dir/release.json")"
  if [ "$resume" != true ] && [ "$(node -p 'require(process.argv[1]).isDraft' "$catalog_dir/release.json")" != true ]; then
    fail "Public Plugin release has an incomplete Catalog; refusing to alter it"
  fi
elif ! grep -Eqi 'release not found|HTTP 404' "$catalog_dir/release.error"; then
  cat "$catalog_dir/release.error" >&2
  fail "Cannot inspect the existing Plugin release"
fi

if [ "$resume" = true ]; then
  gh release download "$PRODUCT_RELEASE_TAG" --repo "$repo" --pattern catalog.json --pattern catalog.json.minisig --dir "$catalog_dir"
else
  previous_args=()
  if [ -f "$PLUGIN_HANDOFF/previous.bundle.json" ]; then
    node "$CI_ROOT/plugin-catalog-bundle.js" unpack "$PLUGIN_HANDOFF/previous.bundle.json" "$catalog_dir/previous.json" "$catalog_dir/previous.json.minisig"
    minisign -Vm "$catalog_dir/previous.json" -x "$catalog_dir/previous.json.minisig" -P "$(node scripts/release/native/catalog-config.js public-key)"
    previous_args=(--previous "$catalog_dir/previous.json")
  elif [ -f "$PLUGIN_HANDOFF/initialize" ] && [ "${INITIALIZE_CATALOG:-false}" = true ]; then
    touch "$catalog_dir/verify-origin-absence"
  else
    fail "Build artifact lacks its verified Catalog baseline"
  fi
  [ -n "${PLUGIN_CATALOG_PRIVATE_KEY_B64:-}" ] || fail "Missing PLUGIN_CATALOG_PRIVATE_KEY_B64"
  node scripts/release/docker/images.js --publish-only --artifacts "$assets_dir" --platform "$PRODUCT_PLATFORM" --version "$PRODUCT_VERSION" \
    --revision "$PLUGIN_REVISION" --orchestrator-revision "$orchestrator_revision" \
    --output "$catalog_dir/catalog.json" ${previous_args[@]+"${previous_args[@]}"}
  if [ -f "$catalog_dir/publish-decision.txt" ] && [ "$(tr -d '[:space:]' < "$catalog_dir/publish-decision.txt")" = unchanged ]; then
    echo "No appliance image version advanced; catalog unchanged."
    exit 0
  fi
  (umask 077; printf '%s' "$PLUGIN_CATALOG_PRIVATE_KEY_B64" | base64 --decode > "$catalog_dir/catalog.key")
  minisign -Sm "$catalog_dir/catalog.json" -s "$catalog_dir/catalog.key" -x "$catalog_dir/catalog.json.minisig"
  rm -f "$catalog_dir/catalog.key"
  # Verify the configured private/public key pair before uploading anything.
  minisign -Vm "$catalog_dir/catalog.json" -x "$catalog_dir/catalog.json.minisig" \
    -P "$(node scripts/release/native/catalog-config.js public-key)"
  if [ "$exists" != true ]; then
    gh release create "$PRODUCT_RELEASE_TAG" --repo "$repo" --draft --latest=false \
      --title "MeowLink Plugins $PRODUCT_VERSION" --notes "Official plugin packages $PRODUCT_VERSION"
  fi
  upload_github_release_asset_if_changed "$PRODUCT_RELEASE_TAG" "$repo" "$catalog_dir/catalog.json"
  upload_github_release_asset_if_changed "$PRODUCT_RELEASE_TAG" "$repo" "$catalog_dir/catalog.json.minisig"
fi

# Verify the signed complete snapshot and every referenced registry image on retry.
minisign -Vm "$catalog_dir/catalog.json" -x "$catalog_dir/catalog.json.minisig" -P "$(node scripts/release/native/catalog-config.js public-key)"
node scripts/release/docker/images.js --verify --platform "$PRODUCT_PLATFORM" --version "$PRODUCT_VERSION" \
  --revision "$PLUGIN_REVISION" --orchestrator-revision "$orchestrator_revision" --output "$catalog_dir/catalog.json"

node "$CI_ROOT/plugin-catalog-bundle.js" pack "$catalog_dir/catalog.json" "$catalog_dir/catalog.json.minisig" "$catalog_dir/catalog.bundle.json"

assume_aws_role "$PLUGIN_PUBLISH_ROLE_ARN"
if [ -f "$catalog_dir/verify-origin-absence" ]; then
  count="$(aws s3api list-objects-v2 --bucket "$RUNTIME_CATALOG_BUCKET" --prefix "plugins/docker/stable/${PRODUCT_PLATFORM}/" --max-keys 1 --query KeyCount --output text)"
  [ "$count" = 0 ] || fail "Refusing to initialize an existing Plugin Catalog hidden by the CDN"
fi
for name in catalog.json catalog.json.minisig catalog.bundle.json; do
  publish_immutable_s3 "$catalog_dir/$name" "$RUNTIME_CATALOG_BUCKET" \
    "plugins/docker/catalogs/${PRODUCT_VERSION}/${PRODUCT_PLATFORM}/$name" application/octet-stream
done
gh release edit "$PRODUCT_RELEASE_TAG" --repo "$repo" --draft=false --latest=false
for name in catalog.json catalog.json.minisig; do
  curl --fail --location --silent --show-error --retry 8 --retry-all-errors \
    "https://github.com/${repo}/releases/download/${PRODUCT_RELEASE_TAG}/$name" --output "$catalog_dir/public-$name"
  cmp -s "$catalog_dir/$name" "$catalog_dir/public-$name" || fail "Public Plugin Catalog differs after publication"
done

# The workflow lock serializes writers for this platform. Reject an old tag
# replay rather than moving stable backwards after an otherwise valid retry.
if aws s3 cp "s3://${RUNTIME_CATALOG_BUCKET}/plugins/docker/stable/${PRODUCT_PLATFORM}/catalog.bundle.json" "$catalog_dir/current.bundle.json" --only-show-errors 2> "$catalog_dir/current.error"; then
  node "$CI_ROOT/plugin-catalog-bundle.js" unpack "$catalog_dir/current.bundle.json" "$catalog_dir/current.json" "$catalog_dir/current.json.minisig"
  minisign -Vm "$catalog_dir/current.json" -x "$catalog_dir/current.json.minisig" -P "$(node scripts/release/native/catalog-config.js public-key)"
  node "$CI_ROOT/verify-catalog-promotion.js" "$catalog_dir/current.json" "$catalog_dir/catalog.json"
elif ! grep -Eqi '404|NoSuchKey|does not exist' "$catalog_dir/current.error"; then
  cat "$catalog_dir/current.error" >&2
  fail "Cannot verify the current Plugin Catalog before promotion"
fi
for name in catalog.json.minisig catalog.json catalog.bundle.json; do
  aws s3 cp "$catalog_dir/$name" "s3://${RUNTIME_CATALOG_BUCKET}/plugins/docker/stable/${PRODUCT_PLATFORM}/$name" \
    --content-type application/octet-stream --cache-control 'no-cache,max-age=0'
  aws s3 cp "s3://${RUNTIME_CATALOG_BUCKET}/plugins/docker/stable/${PRODUCT_PLATFORM}/$name" "$catalog_dir/promoted-$name" --only-show-errors
  cmp -s "$catalog_dir/$name" "$catalog_dir/promoted-$name" || fail "Plugin stable promotion verification failed"
done
echo "Published Plugin appliance release $PRODUCT_RELEASE_TAG"
