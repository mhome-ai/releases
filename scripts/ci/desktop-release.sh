#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
source "$HERE/lib.sh"

tag="${RELEASE_TAG:?}"
repo="${GITHUB_RELEASE_REPO}"
read_product_tag "$tag"
[ "$PRODUCT_CHANNEL" = "desktop" ] || fail "$tag is not a desktop product tag"
require_mhome_clone baycat
require_mhome_clone meowcore-rust
require_mhome_clone agent
require_mhome_clone pallas-cat
require_mhome_clone releases
require_cmd git node cargo gh

HEARTBEAT_PID=""
start_heartbeat() {
  (
    while true; do
      echo "[heartbeat] $(date -u +%Y-%m-%dT%H:%M:%SZ) desktop release still running"
      sleep 30
    done
  ) &
  HEARTBEAT_PID=$!
}
stop_heartbeat() {
  if [ -n "${HEARTBEAT_PID:-}" ]; then
    kill "$HEARTBEAT_PID" 2>/dev/null || true
    HEARTBEAT_PID=""
  fi
}

cleanup() {
  stop_heartbeat
  if [ "${SIGNING_KEYCHAIN:-}" = "1" ]; then
    bash "$CI_ROOT/macos-signing-keychain.sh" release desktop || true
  fi
  cleanup_worktree || echo "::warning::release worktree cleanup failed for $WORK_ROOT"
}
trap cleanup EXIT

verify_macos_runtime_catalog() {
  local directory
  directory="$(mktemp -d "${TMPDIR:-/tmp}/meowlink-desktop-preflight.XXXXXX")"
  curl -fsSL --retry 3 --proto '=https' --tlsv1.2 \
    "$(node scripts/release/native/runtime-catalog-config.js catalog-url darwin-arm64)" \
    -o "$directory/catalog.json"
  curl -fsSL --retry 3 --proto '=https' --tlsv1.2 \
    "$(node scripts/release/native/runtime-catalog-config.js signature-url darwin-arm64)" \
    -o "$directory/catalog.json.minisig"
  node scripts/release/native/runtime-catalog-config.js public-key-file darwin-arm64 \
    > "$directory/catalog.pub"
  cargo run --profile local-package --quiet -p runtime-release-verify --bin runtime-release-verify -- \
    --catalog "$directory/catalog.json" \
    --signature "$directory/catalog.json.minisig" \
    --public-key "$directory/catalog.pub" \
    --desktop-version "$APP_VERSION"
  rm -rf "$directory"
}

resolve_windows_codesign_home() {
  local candidate
  for candidate in "${CODESIGNTOOL_HOME:-}" "C:\\CodeSignTool" "/c/CodeSignTool" "/C/CodeSignTool"; do
    [ -n "$candidate" ] || continue
    if [ -d "$candidate" ]; then
      printf '%s' "$candidate"
      return 0
    fi
  done
  if powershell.exe -NoProfile -Command "if (Test-Path -LiteralPath 'C:\CodeSignTool') { exit 0 } else { exit 1 }"; then
    printf '%s' 'C:\CodeSignTool'
    return 0
  fi
  return 1
}

windows_desktop_preflight() {
  require_cmd java curl powershell.exe
  local name
  for name in SSL_COM_USERNAME SSL_COM_PASSWORD SSL_COM_CREDENTIAL_ID SSL_COM_TOTP_SECRET TAURI_SIGNING_PRIVATE_KEY; do
    eval "value=\${$name:-}"
    [ -n "$value" ] || fail "Missing $name (needed before the Windows desktop compile)"
  done
  local home
  if home="$(resolve_windows_codesign_home)"; then
    export CODESIGNTOOL_HOME="$home"
    echo "Using existing CodeSignTool at $CODESIGNTOOL_HOME"
  fi
}

install_windows_codesign() {
  require_cmd java curl
  local home
  if home="$(resolve_windows_codesign_home)"; then
    export CODESIGNTOOL_HOME="$home"
    echo "Skipping CodeSignTool download; using $CODESIGNTOOL_HOME"
    return 0
  fi
  echo "CodeSignTool not found locally; downloading from ssl.com with retries"
  local root="${RUNNER_TEMP:-$WORK_ROOT}/meow-codesign"
  mkdir -p "$root"
  local zip="$root/codesigntool.zip"
  curl --location --fail --retry 8 --retry-all-errors --retry-delay 2 \
    --retry-max-time 180 --connect-timeout 20 \
    -o "$zip" "https://www.ssl.com/download/codesigntool-for-windows/"
  local win_zip="$zip" win_root="$root"
  if command -v cygpath >/dev/null 2>&1; then
    win_zip="$(cygpath -w "$zip")"
    win_root="$(cygpath -w "$root")"
  fi
  powershell.exe -NoProfile -Command \
    "Expand-Archive -LiteralPath '$win_zip' -DestinationPath '$win_root' -Force"
  export CODESIGNTOOL_HOME="$win_root"
}

verify_windows_installer() {
  local win_root="$PWD/tauri/target/release"
  if command -v cygpath >/dev/null 2>&1; then
    win_root="$(cygpath -w "$win_root")"
  fi
  MEOW_NSIS_ROOT="$win_root" powershell.exe -NoProfile -Command '
    $root = $env:MEOW_NSIS_ROOT
    $files = @(Get-ChildItem -LiteralPath (Join-Path $root "bundle\nsis") -Filter *.exe)
    if ($files.Count -ne 1) { throw "Expected exactly one NSIS installer" }
    foreach ($file in $files) {
      $signature = Get-AuthenticodeSignature $file.FullName
      if ($signature.Status -ne "Valid") { throw "Installer signature is $($signature.Status)" }
      if (-not $signature.TimeStamperCertificate) { throw "Installer is missing a timestamp" }
    }
  '
}

if [ "$PRODUCT_PREFIX" = "aw" ]; then
  windows_desktop_preflight
fi
prepare_product_sources --with-meowcore --with-pallas
cd "$BAYCAT_DIR"
APP_VERSION="$(node -p "require('./package.json').version")"
node scripts/release/resolve-release-platforms.js --event push --ref "$tag" >/dev/null
notes_file="$BAYCAT_DIR/build/release-notes.md"
mkdir -p "$BAYCAT_DIR/build"
node scripts/release/format-release-notes.js --version "$APP_VERSION" > "$notes_file"

case "$PRODUCT_PREFIX" in
  am)
    require_cmd codesign security curl
    SIGNING_KEYCHAIN=1
    bash "$CI_ROOT/macos-signing-keychain.sh" acquire desktop
    bash scripts/release/mac/check-mac-runner.sh
    bash scripts/ci/ci-install-release-deps.sh "$APP_VERSION"
    verify_macos_runtime_catalog
    bash scripts/release/mac/preflight-mac-release.sh --tag "$PRODUCT_SOURCE_TAG" --sign-smoke
    bash scripts/release/mac/mac-release-persist.sh prepare-run \
      "$APP_VERSION" "${GITHUB_RUN_ATTEMPT:-1}"
    bash scripts/release/mac/build-mac-release-bundles.sh --resume --allow-unstapled
    bash scripts/ci/ci-notarize-staged-dmgs.sh --allow-unstapled
    bash scripts/release/mac/verify-mac-dmg-notarization.sh --allow-unstapled
    sh scripts/release/mac/verify-mac-staging.sh
    sh scripts/ci/ci-publish-mac-from-staging.sh \
      --repo "$repo" \
      --tag "$PRODUCT_RELEASE_TAG" \
      --notes-file "$notes_file" \
      --allow-unstapled
    ;;
  aw)
    windows_desktop_preflight
    export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=2048}"
    export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-2}"
    start_heartbeat
    sh scripts/release/mac/audit-mac-release-scripts.sh
    bash scripts/ci/ci-install-release-deps.sh "$APP_VERSION"
    install_windows_codesign
    npm run tauri:build:signed
    verify_windows_installer
    mkdir -p release-artifacts/windows
    cp tauri/target/release/bundle/nsis/*.exe tauri/target/release/bundle/nsis/*.sig \
      release-artifacts/windows/ 2>/dev/null || fail "missing Windows NSIS artifacts"
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
    ;;
  al) fail "Linux Desktop is not enabled" ;;
  *) fail "unknown desktop prefix $PRODUCT_PREFIX" ;;
esac
