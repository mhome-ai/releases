#!/usr/bin/env bash
set -euo pipefail

# Match Camera's pinned static toolchain without raising the Debian 11 baseline.
# These are image dependencies, not job inputs or environment overrides.
case "$(dpkg --print-architecture)" in
  amd64)
    upstream_arch=x64
    ffmpeg_sha=bfe8a8fc511530457b528c48d77b5737527b504a3797a9bc4866aeca69c2dffa
    ffprobe_sha=25d9b6ccb05e3d9de9e04e31e2506d8dd7f9f0418981965ac6df12e8d3afd067
    ;;
  arm64)
    upstream_arch=arm64
    ffmpeg_sha=754a678672298bc68156adff58aa7385a592c2b30b1d0ae8750c45c915c4bac0
    ffprobe_sha=2ab6aba60ee84412dff9188720703376cb4e7aaf7e0b5e43aa8249f2acae5bf8
    ;;
  *) echo 'Unsupported FFmpeg runner architecture' >&2; exit 1 ;;
esac

scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
base=https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1

download() {
  local asset="$1" destination="$2" checksum="$3"
  curl --fail --silent --show-error --location --retry 3 --connect-timeout 15 --max-time 180 \
    "$base/$asset" -o "$destination"
  printf '%s  %s\n' "$checksum" "$destination" | sha256sum -c -
}

for binary in ffmpeg ffprobe; do
  if [[ "$binary" == ffmpeg ]]; then checksum="$ffmpeg_sha"; else checksum="$ffprobe_sha"; fi
  download "$binary-linux-$upstream_arch.gz" "$scratch/$binary.gz" "$checksum"
  gzip -dc "$scratch/$binary.gz" > "$scratch/$binary"
  install -m 755 "$scratch/$binary" "/usr/local/bin/$binary"
done

download "linux-$upstream_arch.LICENSE" "$scratch/LICENSE" \
  8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903
install -d /usr/local/share/doc/ffmpeg
install -m 644 "$scratch/LICENSE" /usr/local/share/doc/ffmpeg/LICENSE
