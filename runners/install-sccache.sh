#!/usr/bin/env bash
set -euo pipefail
version=0.19.0
case "$(dpkg --print-architecture)" in
  arm64) arch=aarch64; checksum=3e47fc4a71b1ddd1b4294a0de9d34498922fdf41e3cd0bda5df3954e3d6deb9d ;;
  amd64) arch=x86_64; checksum=aa73c7270c997894038c0d8f0d297865f57569e1687883322bc431713d4bb9dd ;;
  *) echo 'Unsupported sccache architecture' >&2; exit 1 ;;
esac
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
archive="sccache-v${version}-${arch}-unknown-linux-musl"
curl --fail --location --retry 3 --connect-timeout 15 --max-time 120 \
  "https://github.com/mozilla/sccache/releases/download/v${version}/${archive}.tar.gz" -o "$scratch/tool.tar.gz"
echo "$checksum  $scratch/tool.tar.gz" | sha256sum -c -
tar -xzf "$scratch/tool.tar.gz" -C "$scratch"
install -m 755 "$scratch/$archive/sccache" /usr/local/bin/sccache
mkdir -p /usr/local/share/licenses/sccache
install -m 644 "$scratch/$archive/LICENSE" /usr/local/share/licenses/sccache/LICENSE
