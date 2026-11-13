#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
lock="$root/model-packs.lock.json"

jq -e '
  .schemaVersion == "meow.tts.model-packs.v1" and
  (.releaseVersion | test("^[0-9]+\\.[0-9]+\\.[0-9]+$")) and
  (.packs | length > 0) and
  ([.packs[].id] | unique | length) == (.packs | length) and
  ([.packs[].publicTag] | unique | length) == (.packs | length) and
  all(.packs[];
    (.id | test("^kokoro:v[0-9]")) and
    (.publicTag | test("^kokoro-v.+-r[0-9]+$")) and
    (.modelLicenseEvidenceRevision | test("^[0-9a-f]{40}$")) and
    (.exporterRevision | test("^[0-9a-f]{40}$")) and
    .modelLicense == "Apache-2.0" and
    .exporterLicense == "MIT" and
    (.smokeVocab | test("^vocab/[A-Za-z0-9._-]+\\.json$")) and
    (.smokeVoice | length > 0) and
    (.smokePhonemes | length > 0) and
    (.artifacts | length == 2) and
    ([.artifacts[].id] | unique | length) == (.artifacts | length) and
    all(.artifacts[];
      (.sourceUrl | test("^https://github\\.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v[0-9.]+/")) and
      (.fileName | test("^[A-Za-z0-9._-]+$")) and
      (.sha256 | test("^[0-9a-f]{64}$")) and
      .sizeBytes > 0
    )
  )
' "$lock" >/dev/null

test -f "$root/LICENSES/Kokoro-Apache-2.0.txt"
test -f "$root/LICENSES/kokoro-onnx-MIT.txt"
test -f "$root/MODEL_THIRD_PARTY_NOTICES.md"

while IFS= read -r vocab; do
  test -f "$root/$vocab"
done < <(jq -r '.packs[].smokeVocab' "$lock")
