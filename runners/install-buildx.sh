#!/usr/bin/env bash
set -euo pipefail
version=0.38.2
case "$(dpkg --print-architecture)" in
  arm64) arch=arm64; checksum=46c0f334772de3cb0b341cc415caf7339fb5cfc8b8438ebcb5a10e7f23800d36 ;;
  amd64) arch=amd64; checksum=7992ec09413b80ff57ba4e081f56fc833d7bac1d5e71143c6c809e7e6065f6d6 ;;
  *) echo 'Unsupported Buildx architecture' >&2; exit 1 ;;
esac
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
curl --fail --location --retry 3 --connect-timeout 15 --max-time 180 \
  "https://github.com/docker/buildx/releases/download/v${version}/buildx-v${version}.linux-${arch}" -o "$scratch/buildx"
echo "$checksum  $scratch/buildx" | sha256sum -c -
curl --fail --location --retry 3 --connect-timeout 15 --max-time 60 \
  "https://raw.githubusercontent.com/docker/buildx/v${version}/LICENSE" -o "$scratch/LICENSE"
echo 'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30  '"$scratch/LICENSE" | sha256sum -c -
install -D -m 755 "$scratch/buildx" /usr/local/lib/docker/cli-plugins/docker-buildx
install -D -m 644 "$scratch/LICENSE" /usr/local/share/licenses/buildx/LICENSE
docker buildx version
