#!/usr/bin/env bash
set -euo pipefail

# Thin entry used by GitHub Actions. Packs from camera-reid.lock.json and
# optionally publishes an immutable GitHub Release.
publish="${1:-false}"
root="$(cd "$(dirname "$0")/.." && pwd)"
lock="$root/camera-reid.lock.json"

"$root/scripts/verify-camera-reid.sh"
version="$(jq -r '.version' "$lock")"
tag="$(jq -r '.publicTag' "$lock")"
name="$(jq -r '.displayName' "$lock")"
dist="$root/dist/camera-reid-$version"
rm -rf "$dist"
"$root/scripts/prepare-camera-reid.sh" "$dist"

if [[ "$publish" != "true" ]]; then
  echo "Prepared $dist without publishing"
  exit 0
fi

if status="$(gh release view "$tag" --repo mhome-ai/releases --json tagName 2>&1)"; then
  echo "release already exists and will not be overwritten: $tag" >&2
  exit 1
elif [[ "$status" != "release not found" ]]; then
  printf '%s\n' "$status" >&2
  exit 1
fi

gh release create "$tag" "$dist"/* \
  --repo mhome-ai/releases \
  --target "$(git -C "$root" rev-parse HEAD)" \
  --title "$name" \
  --notes "Camera ReID OSNet ${version}. Immutable ONNX weights for the Camera node." \
  --latest=false
echo "Published https://github.com/mhome-ai/releases/releases/tag/$tag"
