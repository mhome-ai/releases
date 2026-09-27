#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
source "$HERE/lib.sh"
read_product_tag "${RELEASE_TAG:?RELEASE_TAG is required}"
[ "$PRODUCT_CHANNEL" = plugin ] || fail "Expected a Plugin Native release tag"
require_mhome_clone plugin
require_mhome_clone releases
require_cmd git node npm gh curl minisign python3 aws
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
node "$CI_ROOT/prepare-plugin-sources.js" --version "$PRODUCT_VERSION" --work-id "$WORK_ID" > "$prepared"
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
    previous_args=(--previous-catalog "$catalog_dir/previous.json")
  elif [ -f "$PLUGIN_HANDOFF/initialize" ] && [ "${INITIALIZE_CATALOG:-false}" = true ]; then
    touch "$catalog_dir/verify-origin-absence"
  else
    fail "Build artifact lacks its verified Catalog baseline"
  fi
  [ -n "${PLUGIN_CATALOG_PRIVATE_KEY_B64:-}" ] || fail "Missing PLUGIN_CATALOG_PRIVATE_KEY_B64"
  case "$PRODUCT_PLATFORM" in
    darwin-*)
      require_cmd codesign security cc
      SIGNING_KEYCHAIN=1
      bash "$CI_ROOT/macos-signing-keychain.sh" acquire plugin-native
      ;;
    linux-*) ;;
    *) fail "Unsupported plugin platform: $PRODUCT_PLATFORM" ;;
  esac
  node scripts/release/native/package.js --target "$PRODUCT_PLATFORM" --output "$assets_dir" --mode release --phase publish ${previous_args[@]+"${previous_args[@]}"}
  node scripts/release/generate-catalog.js \
    --platform "$PRODUCT_PLATFORM" --version "$PRODUCT_VERSION" --tag "$PRODUCT_RELEASE_TAG" \
    --repository "$repo" --source-repository mhome-ai/plugin --source-revision "$PLUGIN_REVISION" \
    --orchestrator-revision "$(git -C "$RELEASES_DIR" rev-parse HEAD)" \
    --workflow-run-url "${GITHUB_SERVER_URL:-https://github.com}/${repo}/actions/runs/${GITHUB_RUN_ID:?}" \
    --assets-dir "$assets_dir" --runtime-alternatives true --output "$catalog_dir/catalog.json" \
    --publish-assets-output "$catalog_dir/publish-assets.txt" ${previous_args[@]+"${previous_args[@]}"}
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
  while IFS= read -r name; do
    [ -z "$name" ] || upload_github_release_asset_if_changed "$PRODUCT_RELEASE_TAG" "$repo" "$assets_dir/$name"
  done < "$catalog_dir/publish-assets.txt"
  upload_github_release_asset_if_changed "$PRODUCT_RELEASE_TAG" "$repo" "$catalog_dir/catalog.json"
  upload_github_release_asset_if_changed "$PRODUCT_RELEASE_TAG" "$repo" "$catalog_dir/catalog.json.minisig"
fi

# Download every referenced archive, including immutable reused assets, and
# verify signature, provenance, package contents and platform signing.
node scripts/release/native/verify-release.js --catalog "$catalog_dir/catalog.json" \
  --signature "$catalog_dir/catalog.json.minisig" --platform "$PRODUCT_PLATFORM" --repository "$repo" \
  --revision "$PLUGIN_REVISION" --orchestrator-revision "$(git -C "$RELEASES_DIR" rev-parse HEAD)" --version "$PRODUCT_VERSION" --assets-dir "$assets_dir"
cp "$catalog_dir/catalog.json" "$catalog_dir/catalog.json.minisig" "$assets_dir/"
node scripts/release/native/verify-github-release-assets.js --repository "$repo" --tag "$PRODUCT_RELEASE_TAG" --assets-dir "$assets_dir"

node "$CI_ROOT/plugin-catalog-bundle.js" pack "$catalog_dir/catalog.json" "$catalog_dir/catalog.json.minisig" "$catalog_dir/catalog.bundle.json"

assume_aws_role "$PLUGIN_PUBLISH_ROLE_ARN"
if [ -f "$catalog_dir/verify-origin-absence" ]; then
  count="$(aws s3api list-objects-v2 --bucket "$RUNTIME_CATALOG_BUCKET" --prefix "plugins/stable/${PRODUCT_PLATFORM}/" --max-keys 1 --query KeyCount --output text)"
  [ "$count" = 0 ] || fail "Refusing to initialize an existing Plugin Catalog hidden by the CDN"
fi
for name in catalog.json catalog.json.minisig catalog.bundle.json; do
  publish_immutable_s3 "$catalog_dir/$name" "$RUNTIME_CATALOG_BUCKET" \
    "plugins/catalogs/${PRODUCT_PLATFORM}/${PRODUCT_VERSION}/$name" application/octet-stream
done
gh release edit "$PRODUCT_RELEASE_TAG" --repo "$repo" --draft=false --latest=false
for name in catalog.json catalog.json.minisig; do
  curl --fail --location --silent --show-error --retry 8 --retry-all-errors \
    "https://github.com/${repo}/releases/download/${PRODUCT_RELEASE_TAG}/$name" --output "$catalog_dir/public-$name"
  cmp -s "$catalog_dir/$name" "$catalog_dir/public-$name" || fail "Public Plugin Catalog differs after publication"
done

# The workflow lock serializes writers for this platform. Reject an old tag
# replay rather than moving stable backwards after an otherwise valid retry.
if aws s3 cp "s3://${RUNTIME_CATALOG_BUCKET}/plugins/stable/${PRODUCT_PLATFORM}/catalog.bundle.json" "$catalog_dir/current.bundle.json" --only-show-errors 2> "$catalog_dir/current.error"; then
  node "$CI_ROOT/plugin-catalog-bundle.js" unpack "$catalog_dir/current.bundle.json" "$catalog_dir/current.json" "$catalog_dir/current.json.minisig"
  minisign -Vm "$catalog_dir/current.json" -x "$catalog_dir/current.json.minisig" -P "$(node scripts/release/native/catalog-config.js public-key)"
  node "$CI_ROOT/verify-catalog-promotion.js" "$catalog_dir/current.json" "$catalog_dir/catalog.json"
elif ! grep -Eqi '404|NoSuchKey|does not exist' "$catalog_dir/current.error"; then
  cat "$catalog_dir/current.error" >&2
  fail "Cannot verify the current Plugin Catalog before promotion"
fi
for name in catalog.json.minisig catalog.json catalog.bundle.json; do
  aws s3 cp "$catalog_dir/$name" "s3://${RUNTIME_CATALOG_BUCKET}/plugins/stable/${PRODUCT_PLATFORM}/$name" \
    --content-type application/octet-stream --cache-control 'no-cache,max-age=0'
  aws s3 cp "s3://${RUNTIME_CATALOG_BUCKET}/plugins/stable/${PRODUCT_PLATFORM}/$name" "$catalog_dir/promoted-$name" --only-show-errors
  cmp -s "$catalog_dir/$name" "$catalog_dir/promoted-$name" || fail "Plugin stable promotion verification failed"
done
echo "Published Plugin Native release $PRODUCT_RELEASE_TAG"
