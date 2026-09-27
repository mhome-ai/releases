#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
source "$HERE/lib.sh"
read_product_tag "${RELEASE_TAG:?}"
case "$PRODUCT_CHANNEL" in plugin|plugin-docker) ;; *) fail "Expected a Plugin release" ;; esac
# This stage runs on the existing trusted self-hosted release runner. Signing
# secrets are injected only into the subsequent publish step, not this shell.
for name in PLUGIN_CATALOG_PRIVATE_KEY_B64 APPLE_CSC_LINK APPLE_CSC_KEY_PASSWORD AWS_SECRET_ACCESS_KEY; do
  [ -z "${!name:-}" ] || fail "Publisher secret present in Plugin build stage: $name"
done
handoff="${PLUGIN_HANDOFF:?PLUGIN_HANDOFF is required}"
[ -z "${WORK_SUFFIX:-}" ] || [ "$PRODUCT_PLATFORM" = "$WORK_SUFFIX" ] || fail "Plugin tag does not match this runner target"
cleanup() {
  # Keep the orchestrator and handoff for the next step on the same runner.
  # The workflow owns final cleanup, including after build failures.
  local directory="$WORK_ROOT/plugin"
  if [ -e "$directory/.git" ]; then
    git -C "$MHOME/plugin" worktree remove --force "$directory"
  fi
}
trap cleanup EXIT
prepared="$(mktemp)"
node "$CI_ROOT/prepare-plugin-sources.js" --version "$PRODUCT_VERSION" --work-id "$WORK_ID" > "$prepared"
while IFS= read -r line; do
  case "$line" in plugin_dir=*) PLUGIN_DIR="${line#plugin_dir=}" ;; plugin_revision=*) PLUGIN_REVISION="${line#plugin_revision=}" ;; esac
done < "$prepared"
rm -f "$prepared"
cd "${PLUGIN_DIR:?}"
npm ci --ignore-scripts
bash scripts/release/quality-gate.sh
mkdir -p "$handoff/assets"
if [ "$PRODUCT_CHANNEL" = plugin ]; then
  url="https://install.mhome.ai/plugins/stable/$PRODUCT_PLATFORM/catalog.bundle.json"
else
  url="https://install.mhome.ai/plugins/docker/stable/$PRODUCT_PLATFORM/catalog.bundle.json"
fi
status="$(curl --location --silent --show-error --retry 8 --retry-all-errors --connect-timeout 15 --max-time 120 --output "$handoff/previous.bundle.json" --write-out '%{http_code}' "$url")"
previous_args=()
if [ "$status" = 200 ]; then
  node "$CI_ROOT/plugin-catalog-bundle.js" unpack "$handoff/previous.bundle.json" "$handoff/previous.json" "$handoff/previous.json.minisig"
  minisign -Vm "$handoff/previous.json" -x "$handoff/previous.json.minisig" -P "$(node scripts/release/native/catalog-config.js public-key)"
  previous_args=(--previous-catalog "$handoff/previous.json")
elif { [ "$status" = 403 ] || [ "$status" = 404 ]; } && [ "${INITIALIZE_CATALOG:-false}" = true ]; then
  rm "$handoff/previous.bundle.json"
  touch "$handoff/initialize"
else
  fail "Cannot read the previous Plugin Catalog ($status)"
fi
if [ "$PRODUCT_CHANNEL" = plugin ]; then
  node scripts/release/native/package.js --target "$PRODUCT_PLATFORM" --mode release --phase build --output "$handoff/assets" ${previous_args[@]+"${previous_args[@]}"}
else
  if [ "${#previous_args[@]}" -gt 0 ]; then previous_args=(--previous "$handoff/previous.json"); fi
  node scripts/release/docker/images.js --build-only --platform "$PRODUCT_PLATFORM" --version "$PRODUCT_VERSION" --revision "$PLUGIN_REVISION" \
    --orchestrator-revision "$(git -C "$RELEASES_DIR" rev-parse HEAD)" --artifacts "$handoff/assets" ${previous_args[@]+"${previous_args[@]}"}
fi
node "$CI_ROOT/verify-plugin-handoff.js" --write "$handoff" "$PLUGIN_REVISION" "$(git -C "$RELEASES_DIR" rev-parse HEAD)" "$PRODUCT_RELEASE_TAG"
