#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
source "$HERE/lib.sh"

tag="${RELEASE_TAG:?RELEASE_TAG is required}"
repo="${GITHUB_REPOSITORY:-mhome-ai/releases}"
read_product_tag "$tag"
[ "$PRODUCT_CHANNEL" = "native" ] || fail "$tag is not a native product tag"
require_mhome_clone baycat
require_mhome_clone meowcore-rust
require_mhome_clone agent-rust
require_mhome_clone releases
require_cmd git node cargo gh curl minisign

cleanup() {
  if [ "${SIGNING_KEYCHAIN:-}" = "1" ]; then
    bash "$CI_ROOT/macos-signing-keychain.sh" release native-runtime || true
  fi
  cleanup_worktree || echo "::warning::release worktree cleanup failed for $WORK_ROOT"
}
trap cleanup EXIT

prepare_product_sources --with-meowcore --baycat-version-mode match
cd "$BAYCAT_DIR"

case "$PRODUCT_PLATFORM" in
  darwin-arm64|darwin-x64)
    rust_target="aarch64-apple-darwin"
    [ "$PRODUCT_PLATFORM" = "darwin-x64" ] && rust_target="x86_64-apple-darwin"
    require_cmd codesign security cc
    bash scripts/release/native/quality-gate.sh
    SIGNING_KEYCHAIN=1
    bash "$CI_ROOT/macos-signing-keychain.sh" acquire native-runtime
    bash scripts/release/mac/check-mac-runner.sh --skip-rust
    bash scripts/release/native/package-macos-runtime.sh \
      "$PRODUCT_PLATFORM" "$rust_target" \
      "build/native-runtime/${PRODUCT_PLATFORM}"
    assets_dir="build/native-runtime/${PRODUCT_PLATFORM}"
    ;;
  linux-arm64|linux-x64)
    rust_target="aarch64-unknown-linux-gnu"
    [ "$PRODUCT_PLATFORM" = "linux-x64" ] && rust_target="x86_64-unknown-linux-gnu"
    cargo test --profile local-package -p runtime-release-verify
    cargo test --profile local-package -p client
    bash scripts/release/native/package-linux-runtime.sh \
      "$PRODUCT_PLATFORM" "$rust_target" \
      "build/native-runtime/${PRODUCT_PLATFORM}"
    assets_dir="build/native-runtime/${PRODUCT_PLATFORM}"
    ;;
  windows)
    node --test scripts/release/windows/windows-release.test.js
    pwsh -File scripts/release/native/package-windows-runtime.ps1 \
      -OutputDirectory "build/native-runtime/windows-x64"
    assets_dir="build/native-runtime/windows-x64"
    ;;
  *) fail "unsupported native platform $PRODUCT_PLATFORM" ;;
esac

mkdir -p build/runtime-catalog/tooling build/native-runtime-assets
if command -v bsdtar >/dev/null 2>&1; then
  ln -s "$(command -v bsdtar)" build/runtime-catalog/tooling/tar
  export PATH="$PWD/build/runtime-catalog/tooling:$PATH"
fi
cp "$assets_dir"/* build/native-runtime-assets/

catalog_url="$(node scripts/release/native/runtime-catalog-config.js catalog-url "$PRODUCT_PLATFORM")"
signature_url="$(node scripts/release/native/runtime-catalog-config.js signature-url "$PRODUCT_PLATFORM")"
fetch_status() {
  local url="$1" output="$2" status
  status="$(curl --location --silent --show-error \
    --retry 8 --retry-all-errors --retry-delay 2 --retry-max-time 90 \
    --connect-timeout 15 \
    --output "$output" --write-out '%{http_code}' "$url")" || {
    echo "::error::Failed to fetch $url after retries" >&2
    exit 1
  }
  printf '%s' "$status"
}
catalog_status="$(fetch_status "$catalog_url" build/runtime-catalog/previous-catalog.json)"
signature_status="$(fetch_status "$signature_url" build/runtime-catalog/previous-catalog.json.minisig)"
# First platform catalog has no predecessor. Bash 3.2 + set -u treats
# "${arr[@]}" as unbound when arr is empty (macOS /bin/bash); the EXIT trap
# then reports 0, so the job looks green. ${arr[@]+"${arr[@]}"} vanishes.
previous_args=()
if [ "$catalog_status" = "200" ] && [ "$signature_status" = "200" ]; then
  node scripts/release/native/runtime-catalog-config.js public-key-file \
    > build/runtime-catalog/catalog.pub
  minisign -Vm build/runtime-catalog/previous-catalog.json \
    -x build/runtime-catalog/previous-catalog.json.minisig \
    -p build/runtime-catalog/catalog.pub
  previous_args=(--previous-catalog build/runtime-catalog/previous-catalog.json)
elif { [ "$catalog_status" = "404" ] || [ "$catalog_status" = "403" ]; } \
  && { [ "$signature_status" = "404" ] || [ "$signature_status" = "403" ]; } \
  && [ "${INITIALIZE_CATALOG:-false}" = "true" ]; then
  echo "No Stable Catalog exists; creating the initial Runtime Catalog."
  rm -f build/runtime-catalog/previous-catalog.json build/runtime-catalog/previous-catalog.json.minisig
else
  fail "Stable Catalog is incomplete (catalog HTTP $catalog_status, signature HTTP $signature_status). First release must set initialize_catalog=true."
fi

[ -n "${RUNTIME_CATALOG_PRIVATE_KEY_B64:-}" ] || fail "Missing RUNTIME_CATALOG_PRIVATE_KEY_B64"
meowcore_commit="$(node scripts/ci/release-source-dependencies.js show --file release/sources/dependencies.json --field commit)"
meowcore_tag="$(node scripts/ci/release-source-dependencies.js show --file release/sources/dependencies.json --field tag)"
workflow_run_url="${GITHUB_SERVER_URL:-https://github.com}/${repo}/actions/runs/${GITHUB_RUN_ID:-0}"

node scripts/release/native/generate-runtime-catalog.js \
  --platform "$PRODUCT_PLATFORM" \
  --version "$PRODUCT_VERSION" \
  --tag "$PRODUCT_RELEASE_TAG" \
  --repository "$repo" \
  --source-repository "mhome-ai/baycat" \
  --source-revision "$BAYCAT_REVISION" \
  --workflow-run-url "$workflow_run_url" \
  --meowcore-repository "mhome-ai/meowcore-rust" \
  --meowcore-revision "$meowcore_commit" \
  --meowcore-tag "$meowcore_tag" \
  --agent-revision "$(node -p 'require("../meowcore-rust/release/sources/agent.json").commit')" \
  --assets-dir build/native-runtime-assets \
  --runtime-alternatives true \
  --output build/runtime-catalog/catalog.json \
  --publish-assets-output build/runtime-catalog/publish-assets.txt \
  ${previous_args[@]+"${previous_args[@]}"}

printf '%s' "$RUNTIME_CATALOG_PRIVATE_KEY_B64" | base64 --decode > build/runtime-catalog/catalog.key
minisign -Sm build/runtime-catalog/catalog.json \
  -s build/runtime-catalog/catalog.key \
  -x build/runtime-catalog/catalog.json.minisig
rm -f build/runtime-catalog/catalog.key

release_files=(
  build/runtime-catalog/catalog.json
  build/runtime-catalog/catalog.json.minisig
)
while IFS= read -r file_name; do
  [ -n "$file_name" ] || continue
  release_files+=("build/native-runtime-assets/$file_name")
done < build/runtime-catalog/publish-assets.txt

[ -n "${GH_TOKEN:-}" ] || fail "GH_TOKEN is required to publish"
# GitHub's release create/upload of many large archives in one call races:
# completed catalog files plus sibling tar.gz left in "starter" state, then
# uploads.github.com returns HTTP 400. Create an empty draft, then replace one
# asset at a time.
if ! gh release view "$PRODUCT_RELEASE_TAG" --repo "$repo" >/dev/null 2>&1; then
  gh release create "$PRODUCT_RELEASE_TAG" \
    --repo "$repo" \
    --draft \
    --latest=false \
    --title "MeowLink Runtime ${PRODUCT_VERSION}" \
    --notes "Native MeowLink runtime ${PRODUCT_VERSION}"
fi
is_draft="$(gh release view "$PRODUCT_RELEASE_TAG" --repo "$repo" --json isDraft --jq .isDraft)"
if [ "$is_draft" = "true" ]; then
  for file in "${release_files[@]}"; do
    upload_github_release_asset_if_changed "$PRODUCT_RELEASE_TAG" "$repo" "$file"
  done
else
  echo "Release $PRODUCT_RELEASE_TAG is already public; assets will be verified but never modified."
fi

cp build/runtime-catalog/catalog.json build/runtime-catalog/catalog.json.minisig \
  build/native-runtime-assets/
node scripts/release/native/verify-github-release-assets.js \
  --repository "$repo" \
  --tag "$PRODUCT_RELEASE_TAG" \
  --assets-dir build/native-runtime-assets \
  --staging-dir build/runtime-release-verify

node scripts/release/native/runtime-catalog-config.js public-key-file \
  > build/runtime-release-verify/catalog.pub
case "$PRODUCT_PLATFORM" in
  darwin-arm64|darwin-x64)
    cargo run --profile local-package --quiet -p runtime-release-verify --bin runtime-release-verify -- \
      --catalog build/runtime-release-verify/catalog.json \
      --signature build/runtime-release-verify/catalog.json.minisig \
      --public-key build/runtime-release-verify/catalog.pub
    bash scripts/release/native/verify-macos-runtime-release.sh \
      build/runtime-release-verify \
      build/runtime-release-verify/catalog.json \
      build/runtime-release-verify/catalog.json.minisig \
      build/runtime-release-verify/catalog.pub
    ;;
  linux-arm64|linux-x64)
    bash scripts/release/native/verify-linux-runtime-release.sh \
      build/runtime-release-verify \
      build/runtime-release-verify/catalog.json \
      build/runtime-release-verify/catalog.json.minisig \
      build/runtime-release-verify/catalog.pub
    ;;
  windows)
    pwsh -File scripts/release/native/verify-windows-runtime-release.ps1 \
      -AssetsDirectory "$(pwd)/build/runtime-release-verify" \
      -Catalog "$(pwd)/build/runtime-release-verify/catalog.json" \
      -Signature "$(pwd)/build/runtime-release-verify/catalog.json.minisig" \
      -PublicKey "$(pwd)/build/runtime-release-verify/catalog.pub"
    ;;
esac

[ -n "${RUNTIME_PUBLISH_ROLE_ARN:-}" ] || fail "Missing org variable RUNTIME_PUBLISH_ROLE_ARN"
assume_aws_role "$RUNTIME_PUBLISH_ROLE_ARN"
publish_immutable_s3 \
  build/runtime-catalog/catalog.json \
  "$RUNTIME_CATALOG_BUCKET" \
  "runtime/catalogs/${PRODUCT_PLATFORM}/${PRODUCT_VERSION}/catalog.json" \
  application/json
publish_immutable_s3 \
  build/runtime-catalog/catalog.json.minisig \
  "$RUNTIME_CATALOG_BUCKET" \
  "runtime/catalogs/${PRODUCT_PLATFORM}/${PRODUCT_VERSION}/catalog.json.minisig" \
  application/octet-stream

is_draft="$(gh release view "$PRODUCT_RELEASE_TAG" --repo "$repo" --json isDraft --jq .isDraft)"
if [ "$is_draft" = "true" ]; then
  gh release edit "$PRODUCT_RELEASE_TAG" --repo "$repo" --draft=false --latest=false
fi

verification_dir="$(mktemp -d)"
base_url="https://github.com/${repo}/releases/download/${PRODUCT_RELEASE_TAG}"
curl --fail --location --silent --show-error --retry 8 --retry-all-errors --retry-delay 2 --retry-max-time 90 \
  "$base_url/catalog.json" --output "$verification_dir/catalog.json"
curl --fail --location --silent --show-error --retry 8 --retry-all-errors --retry-delay 2 --retry-max-time 90 \
  "$base_url/catalog.json.minisig" --output "$verification_dir/catalog.json.minisig"
cmp -s build/runtime-catalog/catalog.json "$verification_dir/catalog.json"
cmp -s build/runtime-catalog/catalog.json.minisig "$verification_dir/catalog.json.minisig"

aws s3 cp build/runtime-catalog/catalog.json.minisig \
  "s3://${RUNTIME_CATALOG_BUCKET}/runtime/stable/${PRODUCT_PLATFORM}/catalog.json.minisig" \
  --content-type application/octet-stream \
  --cache-control "no-cache,max-age=0"
aws s3 cp build/runtime-catalog/catalog.json \
  "s3://${RUNTIME_CATALOG_BUCKET}/runtime/stable/${PRODUCT_PLATFORM}/catalog.json" \
  --content-type application/json \
  --cache-control "no-cache,max-age=0"
aws s3 cp "s3://${RUNTIME_CATALOG_BUCKET}/runtime/stable/${PRODUCT_PLATFORM}/catalog.json" \
  "$verification_dir/stable-catalog.json" --only-show-errors
aws s3 cp "s3://${RUNTIME_CATALOG_BUCKET}/runtime/stable/${PRODUCT_PLATFORM}/catalog.json.minisig" \
  "$verification_dir/stable-catalog.json.minisig" --only-show-errors
cmp -s build/runtime-catalog/catalog.json "$verification_dir/stable-catalog.json" \
  || fail "Stable Runtime Catalog differs after S3 promotion"
cmp -s build/runtime-catalog/catalog.json.minisig "$verification_dir/stable-catalog.json.minisig" \
  || fail "Stable Runtime Catalog signature differs after S3 promotion"
rm -rf "$verification_dir"

echo "Published native runtime $PRODUCT_RELEASE_TAG"
