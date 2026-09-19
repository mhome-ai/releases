#!/usr/bin/env bash
# Copy a GitHub SSH private key into a runner-ssh named volume.
# Does not print the key. The compose project creates the volume on first up;
# this can also create it ahead of time.
#
# Usage:
#   seed-runner-ssh.sh meow-linux-arm64-runner_runner-ssh
#   seed-runner-ssh.sh meow-linux-amd64-runner_runner-ssh ~/.ssh/id_ed25519
set -euo pipefail

volume="${1:-}"
key="${2:-$HOME/.ssh/id_ed25519}"
if [ -z "$volume" ] || [ ! -f "$key" ]; then
  echo "Usage: $0 <volume> [private-key-path]" >&2
  exit 2
fi

image=""
for candidate in meow-linux-arm64-runner:local meow-linux-amd64-runner:local ubuntu:24.04; do
  if docker image inspect "$candidate" >/dev/null 2>&1; then
    image="$candidate"
    break
  fi
done
[ -n "$image" ] || {
  echo "no local image to copy the key; build a runner image first" >&2
  exit 1
}

docker volume create "$volume" >/dev/null

pub=""
if [ -f "${key}.pub" ]; then
  pub="${key}.pub"
fi

if [ -n "$pub" ]; then
  docker run --rm --user 0 --entrypoint /bin/sh \
    -v "$volume":/ssh \
    -v "$key":/src/id_ed25519:ro \
    -v "$pub":/src/id_ed25519.pub:ro \
    "$image" \
    -c 'cp /src/id_ed25519 /ssh/id_ed25519 && cp /src/id_ed25519.pub /ssh/id_ed25519.pub && chmod 600 /ssh/id_ed25519 && chmod 644 /ssh/id_ed25519.pub'
else
  docker run --rm --user 0 --entrypoint /bin/sh \
    -v "$volume":/ssh \
    -v "$key":/src/id_ed25519:ro \
    "$image" \
    -c 'cp /src/id_ed25519 /ssh/id_ed25519 && chmod 600 /ssh/id_ed25519'
fi

echo "seeded $volume"
