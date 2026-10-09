#!/usr/bin/env bash
# Promote only this verified desktop release's platform feeds. The caller owns
# the existing desktop-release workflow queue; local unqueued promotion is unsupported.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
source "$HERE/lib.sh"

repo="${1:?release repository is required}"
tag="${2:?release tag is required}"
artifact_root="${3:?artifact root is required}"
baycat="${4:?Baycat source directory is required}"
helper="$baycat/scripts/release/desktop-update-manifest.js"
require_cmd node gh curl aws cargo
[ -n "${DESKTOP_PUBLISH_ROLE_ARN:-}" ] || fail "Missing org variable DESKTOP_PUBLISH_ROLE_ARN"
[ -f "$artifact_root/latest.json" ] || fail "Missing release manifest"
work="$(mktemp -d "${TMPDIR:-/tmp}/desktop-update.XXXXXX")"
trap 'rm -rf "$work"' EXIT

# Validate before any remote write. The release manifest remains the immutable
# authority for cached installs; stable files are projections of these exact bytes.
node "$helper" --manifest "$artifact_root/latest.json" --repo "$repo" --tag "$tag" \
  --output "$work/next" > "$work/targets"
public="$(gh release view "$tag" --repo "$repo" --json isDraft,isPrerelease --jq '.isDraft or .isPrerelease')"
[ "$public" = false ] || fail "Desktop release must be public and stable before promotion"
curl --fail --location --silent --show-error --max-time 120 --retry 3 --retry-all-errors \
  "https://github.com/$repo/releases/download/$tag/latest.json" -o "$work/release.json"
cmp -s "$artifact_root/latest.json" "$work/release.json" || fail "Public release manifest differs"

# Verify all public updater packages before changing any stable entry.
while IFS=$'\t' read -r target url asset; do
  find "$artifact_root" -type f -name "$asset" > "$work/package-paths"
  [ "$(wc -l < "$work/package-paths" | tr -d ' ')" = 1 ] || fail "Expected exactly one local updater package: $asset"
  IFS= read -r package < "$work/package-paths"
  curl --fail --location --silent --show-error --max-time 1800 --retry 3 --retry-all-errors \
    "$url" -o "$work/$asset"
  cmp -s "$package" "$work/$asset" || fail "Public updater package differs: $target"
  # Verify the exact signature clients will read, against their configured key.
  # Tauri CLI only warns when its signing key differs from that public key.
  node -e '
    const fs = require("node:fs");
    const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    process.stdout.write(manifest.platforms[process.argv[2]].signature);
  ' "$work/next/$target.json" "$target" > "$work/$target.sig"
  cargo run --profile local-package --quiet --manifest-path "$baycat/Cargo.toml" \
    -p runtime-manager --bin desktop-updater-verify -- \
    --archive "$work/$asset" --signature "$work/$target.sig" \
    --tauri-config "$baycat/tauri/tauri.conf.json"
done < "$work/targets"

assume_aws_role "$DESKTOP_PUBLISH_ROLE_ARN"
# Read every existing entry before any PUT, so a rollback/conflicting retry in
# one Mac architecture cannot partially promote the other architecture.
while IFS=$'\t' read -r target url asset; do
  key="desktop/stable/$target/latest.json"
  current_args=()
  if aws s3api head-object --bucket "$INSTALL_DISTRIBUTION_BUCKET" --key "$key" > /dev/null 2> "$work/head-error"; then
    aws s3 cp "s3://$INSTALL_DISTRIBUTION_BUCKET/$key" "$work/$target-current.json" --only-show-errors
    current_args=(--current "$work/$target-current.json")
  else
    grep -Eq '404|Not Found|NoSuchKey' "$work/head-error" || { cat "$work/head-error" >&2; fail "Cannot read current desktop feed: $target"; }
  fi
  node "$helper" --manifest "$work/next/$target.json" --target "$target" --repo "$repo" \
    ${current_args[@]+"${current_args[@]}"} > "$work/$target-decision"
done < "$work/targets"

while IFS=$'\t' read -r target url asset; do
  key="desktop/stable/$target/latest.json"
  if [ "$(cat "$work/$target-decision")" = publish ]; then
    # One complete PUT, never delete-then-upload. Other platform feeds are untouched.
    aws s3 cp "$work/next/$target.json" "s3://$INSTALL_DISTRIBUTION_BUCKET/$key" \
      --content-type application/json --cache-control 'no-cache,no-store,max-age=0,must-revalidate' --only-show-errors
  fi
  curl --fail --location --silent --show-error --max-time 120 --retry 3 --retry-all-errors \
    "$INSTALL_DISTRIBUTION_BASE_URL/$key" -o "$work/$target-public.json"
  cmp -s "$work/next/$target.json" "$work/$target-public.json" || fail "Desktop feed verification failed after promotion: $target; retry this release to confirm"
  echo "Verified desktop update: $target"
done < "$work/targets"
