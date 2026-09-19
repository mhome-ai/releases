#!/usr/bin/env bash
# Provision persistent ~/.mhome clones. Workflows fetch tags into worktrees;
# they never clone. Run this from the runner entrypoint, not the image build:
# the SSH key lives in the runner-ssh volume and is not available at build time.
set -euo pipefail

root="${MHOME_ROOT:-$HOME/.mhome}"
mkdir -p "$root"

if [ ! -f "$HOME/.ssh/id_ed25519" ] && [ ! -f "$HOME/.ssh/id_rsa" ]; then
  echo "runner is missing a GitHub SSH key at $HOME/.ssh/id_ed25519" >&2
  echo "put a read key for baycat, meowcore-rust, and releases in the runner-ssh volume" >&2
  exit 1
fi

clone_if_missing() {
  local name="$1"
  local dest="$root/$name"
  if [ -e "$dest/.git" ]; then
    return 0
  fi
  if [ -e "$dest" ]; then
    echo "runner has $dest but it is not a git clone" >&2
    exit 1
  fi
  echo "Cloning mhome-ai/$name into $dest"
  git clone "git@github.com:mhome-ai/${name}.git" "$dest"
}

clone_if_missing baycat
clone_if_missing meowcore-rust
clone_if_missing releases
