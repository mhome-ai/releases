#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
source "$HERE/lib.sh"

tag="${RELEASE_TAG:?}"
repo="${GITHUB_REPOSITORY:-mhome-ai/releases}"
role="${RELEASE_EXTRA:?RELEASE_EXTRA is the desktop role}"
read_product_tag "$tag"
[ "$PRODUCT_CHANNEL" = "desktop" ] || fail "$tag is not a desktop product tag"
require_mhome_clone baycat
require_mhome_clone meowcore-rust
require_mhome_clone pallas-cat
require_mhome_clone releases
require_cmd git node cargo gh

LOCK_NAME=""
if [[ "$role" == macos* ]]; then
  LOCK_NAME="macos-primary"
  bash "$CI_ROOT/machine-lock.sh" acquire "$LOCK_NAME"
fi

cleanup() {
  if [ "${SIGNING_KEYCHAIN:-}" = "1" ]; then
    bash "$CI_ROOT/macos-signing-keychain.sh" release desktop || true
  fi
  cleanup_worktree
  if [ -n "$LOCK_NAME" ]; then
    bash "$CI_ROOT/machine-lock.sh" release "$LOCK_NAME" || true
  fi
}
trap cleanup EXIT

prepare_product_sources --with-meowcore --with-pallas --baycat-version-mode match
cd "$BAYCAT_DIR"
node scripts/release/resolve-release-platforms.js --event push --ref "$tag" >/dev/null
node scripts/release/format-release-notes.js --version "$PRODUCT_VERSION" >/dev/null

publish_mac() {
  local notes_file="$BAYCAT_DIR/build/release-notes.md"
  node scripts/release/format-release-notes.js --version "$PRODUCT_VERSION" > "$notes_file"
  sh scripts/ci/ci-publish-mac-from-staging.sh \
    --repo "$repo" \
    --tag "$PRODUCT_RELEASE_TAG" \
    --notes-file "$notes_file" \
    --allow-unstapled
}

case "$role" in
  macos|macos-publish)
    require_cmd codesign security
    SIGNING_KEYCHAIN=1
    bash "$CI_ROOT/macos-signing-keychain.sh" acquire desktop
    bash scripts/release/mac/check-mac-runner.sh
    bash scripts/ci/ci-install-release-deps.sh "$PRODUCT_VERSION"
    bash scripts/release/mac/mac-release-persist.sh prepare-run \
      "$PRODUCT_VERSION" "${GITHUB_RUN_ATTEMPT:-1}"
    bash scripts/release/mac/build-mac-release-bundles.sh --resume --allow-unstapled
    bash scripts/ci/ci-notarize-staged-dmgs.sh --allow-unstapled
    bash scripts/release/mac/verify-mac-dmg-notarization.sh --allow-unstapled
    sh scripts/release/mac/verify-mac-staging.sh
    if [ "$role" = "macos-publish" ]; then
      publish_mac
    else
      [ -n "${GITHUB_OUTPUT:-}" ] && echo "artifact_dir=$BAYCAT_DIR/build/release-staging/macos" >> "$GITHUB_OUTPUT"
    fi
    ;;
  windows|windows-publish)
    bash scripts/ci/ci-install-release-deps.sh "$PRODUCT_VERSION"
    npm run tauri:build:signed
    if [ "$role" = "windows-publish" ]; then
      notes_file="$BAYCAT_DIR/build/release-notes.md"
      mkdir -p release-artifacts/windows
      cp tauri/target/release/bundle/nsis/*.exe tauri/target/release/bundle/nsis/*.sig \
        release-artifacts/windows/ 2>/dev/null || fail "missing Windows NSIS artifacts"
      node scripts/release/format-release-notes.js --version "$PRODUCT_VERSION" > "$notes_file"
      bash scripts/ci/ci-fetch-release-latest-json.sh \
        --repo "$repo" --tag "$PRODUCT_RELEASE_TAG" --output-dir release-artifacts
      node scripts/release/generate-latest-json.js \
        --repo "$repo" --tag "$PRODUCT_RELEASE_TAG" --notes-file "$notes_file" \
        --artifact-root release-artifacts --output release-artifacts/latest-patch.json \
        --require-windows-only
      node scripts/release/merge-latest-json.js \
        --base release-artifacts/latest.json \
        --patch release-artifacts/latest-patch.json \
        --output release-artifacts/latest.json
      rm -f release-artifacts/latest-patch.json
      bash scripts/release/publish-desktop-release-gh.sh \
        --repo "$repo" --tag "$PRODUCT_RELEASE_TAG" \
        --notes-file "$notes_file" --artifact-root release-artifacts
    else
      [ -n "${GITHUB_OUTPUT:-}" ] && echo "artifact_dir=$BAYCAT_DIR/tauri/target/release/bundle/nsis" >> "$GITHUB_OUTPUT"
    fi
    ;;
  publish)
    [ -n "${DESKTOP_ARTIFACT_ROOT:-}" ] || fail "DESKTOP_ARTIFACT_ROOT is required to merge platform artifacts"
    notes_file="$DESKTOP_ARTIFACT_ROOT/release-notes.md"
    node scripts/release/format-release-notes.js --version "$PRODUCT_VERSION" > "$notes_file"
    bash scripts/ci/ci-fetch-release-latest-json.sh \
      --repo "$repo" --tag "$PRODUCT_RELEASE_TAG" --output-dir "$DESKTOP_ARTIFACT_ROOT"
    node scripts/release/generate-latest-json.js \
      --repo "$repo" --tag "$PRODUCT_RELEASE_TAG" --notes-file "$notes_file" \
      --artifact-root "$DESKTOP_ARTIFACT_ROOT" --output "$DESKTOP_ARTIFACT_ROOT/latest-patch.json"
    node scripts/release/merge-latest-json.js \
      --base "$DESKTOP_ARTIFACT_ROOT/latest.json" \
      --patch "$DESKTOP_ARTIFACT_ROOT/latest-patch.json" \
      --output "$DESKTOP_ARTIFACT_ROOT/latest.json"
    rm -f "$DESKTOP_ARTIFACT_ROOT/latest-patch.json"
    bash scripts/release/publish-desktop-release-gh.sh \
      --repo "$repo" --tag "$PRODUCT_RELEASE_TAG" \
      --notes-file "$notes_file" --artifact-root "$DESKTOP_ARTIFACT_ROOT"
    ;;
  *) fail "unknown desktop role $role" ;;
esac
