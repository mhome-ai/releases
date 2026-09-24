#!/usr/bin/env bash
# Provision persistent ~/.mhome clones. Workflows fetch tags into worktrees;
# they never clone. Run this from the runner entrypoint, not the image build:
# the SSH key lives in the runner-ssh volume and is not available at build time.
set -euo pipefail

root="${MHOME_ROOT:-$HOME/.mhome}"
mkdir -p "$root"
mkdir -p "$HOME/.ssh"
chmod 700 "$HOME/.ssh"

if ! command -v ssh >/dev/null 2>&1 && [ ! -x /usr/bin/ssh ]; then
  echo "runner image is missing openssh-client" >&2
  exit 1
fi
ssh_bin="$(command -v ssh 2>/dev/null || echo /usr/bin/ssh)"

key=""
if [ -f "$HOME/.ssh/id_ed25519" ]; then
  chmod 600 "$HOME/.ssh/id_ed25519"
  key="$HOME/.ssh/id_ed25519"
elif [ -f "$HOME/.ssh/id_rsa" ]; then
  chmod 600 "$HOME/.ssh/id_rsa"
  key="$HOME/.ssh/id_rsa"
else
  echo "runner is missing a GitHub SSH key at $HOME/.ssh/id_ed25519" >&2
  echo "put a read key for baycat, meowcore-rust, agent, agent-cloud, foundation, and releases in the runner-ssh volume" >&2
  exit 1
fi

export GIT_SSH_COMMAND="${ssh_bin} -o BatchMode=yes -o IdentitiesOnly=yes -i ${key}"

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
  echo "Cloning mhome-ai/${2:-$name} into $dest"
  git clone "git@github.com:mhome-ai/${2:-$name}.git" "$dest"
}

clone_if_missing baycat
clone_if_missing meowcore-rust
clone_if_missing releases

clone_if_missing agent agent
clone_if_missing agent-cloud
clone_if_missing foundation
