#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
lock="$root/camera-reid.lock.json"

jq -e '
  .schemaVersion == "meow.camera.reid-osnet.v1" and
  (.version | test("^[0-9]+\\.[0-9]+\\.[0-9]+$")) and
  .publicTag == ("camera-reid-osnet-v" + .version) and
  (.displayName | length > 0) and
  .license == "MIT" and
  (.source.repository | test("^https://")) and
  (.artifacts | length > 0) and
  ([.artifacts[].id] | unique | length) == (.artifacts | length) and
  ([.artifacts[].fileName] | unique | length) == (.artifacts | length) and
  all(.artifacts[];
    (.fileName | test("^[A-Za-z0-9._-]+\\.onnx$")) and
    (.sourceUrl | test("^https://")) and
    (.sha256 | test("^[0-9a-f]{64}$")) and
    .sizeBytes > 0
  )
' "$lock" >/dev/null
