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
protoc --version
pkg-config --modversion dbus-1 gtk+-3.0 ayatana-appindicator3-0.1 libpcap
echo "Debian 11 builder verified ($(dpkg --print-architecture), glibc 2.31)"
