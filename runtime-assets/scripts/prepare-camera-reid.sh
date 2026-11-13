#!/usr/bin/env bash
set -euo pipefail

output="${1:?usage: prepare-camera-reid.sh <output-dir>}"
root="$(cd "$(dirname "$0")/.." && pwd)"
lock="$root/camera-reid.lock.json"

"$root/scripts/verify-camera-reid.sh"

if [[ -e "$output" ]]; then
  echo "output path already exists: $output" >&2
  exit 1
fi
mkdir -p "$output"

while IFS=$'\t' read -r file_name source_url expected_sha expected_size; do
  target="$output/$file_name"
  curl --fail --location --retry 5 --retry-delay 2 --connect-timeout 20 \
    --output "$target" "$source_url"
  actual_sha="$(shasum -a 256 "$target" | awk '{print $1}')"
  actual_size="$(wc -c <"$target" | tr -d ' ')"
  test "$actual_sha" = "$expected_sha"
  test "$actual_size" = "$expected_size"
done < <(
  jq -r '.artifacts[] | [.fileName, .sourceUrl, .sha256, (.sizeBytes | tostring)] | @tsv' "$lock"
)

jq '{schemaVersion, version, publicTag, displayName, license, source, artifacts}' \
  "$lock" >"$output/CAMERA_REID_SOURCE.json"

cat >"$output/CAMERA_REID_NOTICES.txt" <<'EOF'
Camera ReID OSNet ONNX weights.

Upstream: https://github.com/KaiyangZhou/deep-person-reid
Weights: https://huggingface.co/kaiyangzhou/osnet
Paper: https://arxiv.org/abs/1905.00953
License: MIT
EOF

cp "$lock" "$output/camera-reid.lock.json"
(cd "$output" && shasum -a 256 * >SHA256SUMS)
