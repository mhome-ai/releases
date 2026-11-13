#!/usr/bin/env bash
set -euo pipefail

pack_id="${1:?usage: prepare-model-pack.sh <model-id> <output-dir>}"
output="${2:?usage: prepare-model-pack.sh <model-id> <output-dir>}"
root="$(cd "$(dirname "$0")/.." && pwd)"
lock="$root/model-packs.lock.json"

jq -e --arg id "$pack_id" '.packs[] | select(.id == $id)' "$lock" >/dev/null
if [[ -e "$output" ]]; then
  echo "output path already exists: $output" >&2
  exit 1
fi
mkdir -p "$output"

while IFS=$'\t' read -r file_name source_url expected_sha expected_size; do
  target="$output/$file_name"
  cached="${MODEL_PACK_SOURCE_DIR:-}/$file_name"
  if [[ -n "${MODEL_PACK_SOURCE_DIR:-}" && -f "$cached" ]]; then
    cp "$cached" "$target"
  else
    curl --fail --location --retry 5 --retry-delay 2 --connect-timeout 20 \
      --output "$target" "$source_url"
  fi
  actual_sha="$(shasum -a 256 "$target" | awk '{print $1}')"
  actual_size="$(wc -c <"$target" | tr -d ' ')"
  test "$actual_sha" = "$expected_sha"
  test "$actual_size" = "$expected_size"
done < <(
  jq -r --arg id "$pack_id" \
    '.packs[] | select(.id == $id) | .artifacts[] | [.fileName, .sourceUrl, .sha256, (.sizeBytes | tostring)] | @tsv' \
    "$lock"
)

jq --arg id "$pack_id" \
  '{schemaVersion, releaseVersion, pack: (.packs[] | select(.id == $id))}' \
  "$lock" >"$output/KOKORO_MODEL_SOURCE.json"

{
  echo "KOKORO MODEL-PACK DISTRIBUTION NOTICES"
  echo
  cat "$root/MODEL_THIRD_PARTY_NOTICES.md"
  echo
  echo "===== APACHE LICENSE 2.0 ====="
  cat "$root/LICENSES/Kokoro-Apache-2.0.txt"
  echo
  echo "===== KOKORO-ONNX MIT LICENSE ====="
  cat "$root/LICENSES/kokoro-onnx-MIT.txt"
} >"$output/KOKORO_MODEL_NOTICES.txt"

tar -czf "$output/KOKORO_MODEL_LICENSES.tar.gz" \
  -C "$root" MODEL_THIRD_PARTY_NOTICES.md model-packs.lock.json \
  LICENSES/Kokoro-Apache-2.0.txt LICENSES/kokoro-onnx-MIT.txt

(cd "$output" && shasum -a 256 * >SHA256SUMS)
