#!/usr/bin/env bash
set -euo pipefail

# Fixture tools for the internal builder, independent of product bundled tools.
# Keep the Debian 11 baseline and pin a month-end build: daily assets expire
# after 14 days, while upstream retains month-end builds for two years.
release=autobuild-2026-10-31-12-59
version=n9.0.2-39-g7adfbe40dc
case "$(dpkg --print-architecture)" in
  amd64)
    upstream_arch=linux64
    archive_sha=73e29a56974ae5a651133a04584c7483b21afe941e17dc91d79814a758b608d3
    ;;
  arm64)
    upstream_arch=linuxarm64
    archive_sha=6cad88ae5bcec356cfc5d7979a036cc4007128201928a0cf243df3db483276cc
    ;;
  *) echo 'Unsupported FFmpeg runner architecture' >&2; exit 1 ;;
esac

scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
base=https://github.com/FFmpeg-Builds/FFmpeg-Builds/releases/download/$release
archive_root="ffmpeg-$version-$upstream_arch-gpl-9.0"
archive="$archive_root.tar.xz"

curl --fail --silent --show-error --location --retry 3 --connect-timeout 15 --max-time 900 \
  "$base/$archive" -o "$scratch/$archive"
printf '%s  %s\n' "$archive_sha" "$scratch/$archive" | sha256sum -c -

# Extract only the reviewed executables and preserve the upstream GPL text.
# Verify the whole archive before installing either executable.
tar -xJf "$scratch/$archive" -C "$scratch" --no-same-owner --strip-components=2 \
  "$archive_root/bin/ffmpeg" "$archive_root/bin/ffprobe"
tar -xJOf "$scratch/$archive" "$archive_root/LICENSE.txt" > "$scratch/LICENSE"

for binary in ffmpeg ffprobe; do
  install -m 755 "$scratch/$binary" "/usr/local/bin/$binary"
done

install -d /usr/local/share/doc/ffmpeg
install -m 644 "$scratch/LICENSE" /usr/local/share/doc/ffmpeg/LICENSE
cat > /usr/local/share/doc/ffmpeg/SOURCE.txt <<EOF
FFmpeg fixture tools: $version
Producer: https://github.com/FFmpeg-Builds/FFmpeg-Builds
Build: $release
Archive: $base/$archive
Archive SHA-256: $archive_sha
License: GPL-3.0-or-later (see LICENSE)

Build recipes and dependency source revisions:
https://github.com/FFmpeg-Builds/FFmpeg-Builds/tree/$release

These tools are internal builder dependencies, not product bundle inputs.
External redistribution additionally requires the complete corresponding source
and applicable third-party notices; this provenance receipt is not a source offer.
EOF
