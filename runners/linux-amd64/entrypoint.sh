#!/usr/bin/env bash
set -euo pipefail

export HOME=/home/runner
export CARGO_HOME="${CARGO_HOME:-$HOME/.cargo}"
export RUSTUP_HOME="${RUSTUP_HOME:-$HOME/.rustup}"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$HOME/.cache/cargo-target}"
export MHOME_DOWNLOAD_CACHE_ROOT="${MHOME_DOWNLOAD_CACHE_ROOT:-$HOME/.cache/mhome-downloads}"
export PATH="$CARGO_HOME/bin:/usr/local/bin:/usr/bin:/bin"

if [ "$(uname -m)" != "x86_64" ]; then
  echo "linux-amd64-runner must run as linux/amd64; uname -m=$(uname -m)" >&2
  exit 1
fi
if [ -e /proc/sys/fs/binfmt_misc/qemu-x86_64 ] &&
  [ ! -e /proc/sys/fs/binfmt_misc/rosetta ] &&
  [ ! -e /proc/sys/fs/binfmt_misc/rosetta-x86_64 ]; then
  echo "QEMU user emulation is not a release builder. Enable Docker Desktop Rosetta for amd64." >&2
  exit 1
fi

# Named volumes are created as root; make them writable for uid 1001.
sudo mkdir -p "$CARGO_HOME" "$RUSTUP_HOME" "$CARGO_TARGET_DIR" \
  "$MHOME_DOWNLOAD_CACHE_ROOT" "$HOME/actions-runner" "$HOME/_work"
sudo chown -R runner:runner "$CARGO_HOME" "$RUSTUP_HOME" \
  "$(dirname "$CARGO_TARGET_DIR")" "$MHOME_DOWNLOAD_CACHE_ROOT" \
  "$HOME/actions-runner" "$HOME/_work"

if ! command -v rustc >/dev/null 2>&1; then
  echo "Installing Rust toolchain into persistent volumes..."
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
    | sh -s -- -y --default-toolchain stable --profile minimal --no-modify-path
fi
# Native Linux amd64 target; keep explicit so rust-toolchain actions can reuse it.
rustup target add x86_64-unknown-linux-gnu >/dev/null

RUNNER_DIR="$HOME/actions-runner"
RUNNER_VERSION="${RUNNER_VERSION:-2.337.0}"
RUNNER_SHA256="${RUNNER_SHA256:-70920811a4f8ad4328818682bca5c6469c1c942fab52448868071d0063816613}"

if [ ! -x "$RUNNER_DIR/run.sh" ]; then
  echo "Installing GitHub Actions runner ${RUNNER_VERSION} into persistent volume..."
  tmp="$(mktemp)"
  # GitHub publishes this archive as linux-x64; our platform id is linux-amd64.
  curl -fsSL \
    "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-linux-x64-${RUNNER_VERSION}.tar.gz" \
    -o "$tmp"
  echo "${RUNNER_SHA256}  ${tmp}" | sha256sum -c -
  tar -xzf "$tmp" -C "$RUNNER_DIR"
  rm -f "$tmp"
fi

cd "$RUNNER_DIR"
if [ ! -f .runner ]; then
  : "${RUNNER_TOKEN:?RUNNER_TOKEN is required the first time this container configures a runner}"
  : "${RUNNER_NAME:?RUNNER_NAME is required the first time this container configures a runner}"
  if [ -n "${RUNNER_URL:-}" ]; then
    runner_url="$RUNNER_URL"
  elif [ -n "${GITHUB_REPOSITORY:-}" ]; then
    runner_url="https://github.com/${GITHUB_REPOSITORY}"
  else
    echo "RUNNER_URL is required (org: https://github.com/mhome-ai, repo: https://github.com/mhome-ai/baycat)" >&2
    exit 1
  fi
  ./config.sh --unattended --replace \
    --url "$runner_url" \
    --token "${RUNNER_TOKEN}" \
    --name "${RUNNER_NAME}" \
    --labels "${RUNNER_LABELS:-Linux,AMD64,release-linux-amd64}" \
    --work "$HOME/_work"
fi

echo "Linux amd64 runner ready: $(uname -m) rustc=$(rustc --version) node=$(node --version) gh=$(gh --version | head -1)"
exec ./run.sh
