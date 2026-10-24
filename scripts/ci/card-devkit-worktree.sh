#!/usr/bin/env bash
# Source from a frozen workflow; owns only this job's worktree.
set -euo pipefail
root="${MHOME_ROOT:-$HOME/.mhome}"
work="$root/work/card-devkit-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}-${CARD_JOB}"
[ -e "$root/releases/.git" ]
[ ! -e "$work" ]
mkdir -p "$work"
echo "WORK_ROOT=$work" >> "$GITHUB_ENV"
echo "MHOME_ROOT=$root" >> "$GITHUB_ENV"
git -C "$root/releases" fetch --no-tags origin "$GITHUB_SHA"
git -C "$root/releases" worktree add --detach "$work/releases" "$GITHUB_SHA"
