#!/usr/bin/env bash
set -euo pipefail

# Run during image build as the unprivileged runner, without credentials or volumes.
. /etc/os-release
test "$ID" = debian
test "$VERSION_ID" = 11
test "$(getconf GNU_LIBC_VERSION)" = 'glibc 2.31'

scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
cat > "$scratch/smoke.c" <<'EOF'
#include <gnu/libc-version.h>
#include <stdio.h>
int main(void) { puts(gnu_get_libc_version()); return 0; }
EOF
cc -Wall -Werror "$scratch/smoke.c" -o "$scratch/smoke"
test "$("$scratch/smoke")" = 2.31
cat > "$scratch/smoke.cpp" <<'EOF'
#include <iostream>
int main() { std::cout << "c++17 ok\n"; }
EOF
c++ -std=c++17 -Wall -Werror "$scratch/smoke.cpp" -o "$scratch/smoke-cpp"
test "$("$scratch/smoke-cpp")" = 'c++17 ok'

# Loading each CLI catches binaries that require a newer libc than the OEM baseline.
node --version
npm --version
gh --version
docker --version
aws --version
minisign -v
git --version
cmake --version
python3 --version
python3 /usr/local/bin/cleanup-job-target.py --help >/dev/null
test -x "$ACTIONS_RUNNER_HOOK_JOB_STARTED"
test -x "$ACTIONS_RUNNER_HOOK_JOB_COMPLETED"
bash -n "$ACTIONS_RUNNER_HOOK_JOB_STARTED" "$ACTIONS_RUNNER_HOOK_JOB_COMPLETED"
protoc --version
pkg-config --modversion dbus-1 gtk+-3.0 ayatana-appindicator3-0.1 libpcap

# Camera's ordinary Rust tests execute real media tools. Exercise the required
# codecs and modern timing option here, rather than discovering a missing or
# too-old FFmpeg only after compiling the workspace in CI.
ffmpeg -version
ffprobe -version
ffmpeg -hide_banner -loglevel error -f lavfi -i testsrc2=size=64x64:rate=5 \
  -frames:v 2 -filter_threads 1 -threads 1 -c:v libx264 -fps_mode passthrough "$scratch/h264.mp4"
ffmpeg -hide_banner -loglevel error -f lavfi -i testsrc2=size=64x64:rate=5 \
  -frames:v 2 -filter_threads 1 -threads 1 -pix_fmt yuv420p10le -c:v libx265 -preset ultrafast \
  -x265-params pools=1:frame-threads=1:log-level=error -fps_mode passthrough "$scratch/hevc.mp4"
test "$(ffprobe -v error -select_streams v:0 -show_entries stream=codec_name,pix_fmt \
  -of csv=p=0 "$scratch/hevc.mp4")" = 'hevc,yuv420p10le'
ffmpeg -hide_banner -loglevel error -i "$scratch/hevc.mp4" -f null -
ffmpeg -hide_banner -loglevel error -f lavfi -i sine=frequency=440:sample_rate=48000 \
  -t 0.1 -threads 1 -c:a libopus "$scratch/audio.opus"
echo "Debian 11 builder verified ($(dpkg --print-architecture), glibc 2.31)"
