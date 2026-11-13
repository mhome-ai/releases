#!/usr/bin/env bash
set -euo pipefail

run_id="${1:?usage: publish-g2p.sh <successful-tts-run-id> <g2p-source-tag>}"
tag="${2:?missing G2P source tag}"
[[ "$run_id" =~ ^[0-9]+$ && "$tag" =~ ^g2p-v[0-9]+\.[0-9]+\.[0-9]+$ ]]
version="${tag#g2p-v}"
source_repo=mhome-ai/tts
release_repo=mhome-ai/releases

run="$(gh api "repos/$source_repo/actions/runs/$run_id")"
attempt="$(jq -er '
  select(.event == "workflow_dispatch" and .conclusion == "success"
    and .path == ".github/workflows/release-g2p.yml" and .head_branch == "main"
    and .head_repository.full_name == "mhome-ai/tts")
  | .run_attempt | numbers
' <<<"$run")"
source_tag="$(gh api "repos/$source_repo/git/ref/tags/$tag" --jq '.object | select(.type == "tag") | .sha')"
[[ "$source_tag" =~ ^[a-f0-9]{40}$ ]]
source_commit="$(gh api "repos/$source_repo/git/tags/$source_tag" --jq '.object | select(.type == "commit") | .sha')"
[[ "$source_commit" =~ ^[a-f0-9]{40}$ ]]

payload="$(mktemp -d)"
trap 'rm -rf "$payload"' EXIT
gh run download "$run_id" --repo "$source_repo" --name "g2p-release-$attempt" --dir "$payload"
cd "$payload"

receipt="meow-g2p-build-$version.json"
jq -e --arg commit "$source_commit" --arg version "$version" '
  .schemaVersion == "meow.g2p.release.v1" and .sourceCommit == $commit
  and .version == $version and .sourceRepositoryVisibility == "private"
  and ([.builds[].platform] | sort) == ["darwin-arm64","darwin-x64","linux-arm64","linux-x64"]
  and all(.builds[]; .sourceCommit == $commit and .version == $version
    and (if (.platform | startswith("linux-")) then .minimumGlibc == "2.36" else true end))
' "$receipt" >/dev/null

files=("$receipt" "meow-g2p-NOTICES-$version.txt" "meow-g2p-licenses-$version.tar.gz"
  "meow-g2p-sources-$version.json" meow-g2p-en-sbom.cdx.json meow-g2p-zh-sbom.cdx.json)
for platform in darwin-arm64 darwin-x64 linux-arm64 linux-x64; do
  files+=("meow-g2p-toolchain-$platform.json")
  for language in en zh; do
    files+=("meow-g2p-$language-$platform-$version")
  done
done
for file in "${files[@]}"; do test -s "$file"; done
# Hash only the expected files, with portable filenames and the published ordering.
printf '%s\n' "${files[@]}" | LC_ALL=C sort | while IFS= read -r file; do
  shasum -a 256 "$file"
done | diff -u SHA256SUMS -
files+=(SHA256SUMS)

if status="$(gh release view "$tag" --repo "$release_repo" --json tagName 2>&1)"; then
  echo "Release already exists, inspect it before continuing: $tag" >&2
  exit 1
elif [[ "$status" != "release not found" ]]; then
  printf '%s\n' "$status" >&2
  exit 1
fi
release_url="https://github.com/$release_repo.git"
existing_tag="$(git ls-remote "$release_url" "refs/tags/$tag")"
[[ -z "$existing_tag" ]]
target="$(git ls-remote --exit-code "$release_url" refs/heads/main | cut -f1)"
[[ "$target" =~ ^[a-f0-9]{40}$ ]]
notes="Native, Python-free Kokoro G2P workers for macOS and Linux, arm64 and x64. Linux requires glibc 2.36 or newer.

Private source: mhome-ai/tts $tag ($source_commit). Verified build: https://github.com/$source_repo/actions/runs/$run_id."
gh release create "$tag" "${files[@]}" --repo "$release_repo" --target "$target" \
  --draft --latest=false --title "Meow G2P $version" --notes "$notes"
release_id="$(gh release view "$tag" --repo "$release_repo" --json databaseId --jq .databaseId)"
[[ "$release_id" =~ ^[0-9]+$ ]]
assets="$(gh api "repos/$release_repo/releases/$release_id")"
if [[ "$(jq -r '.draft' <<<"$assets")" != "true" ]]; then
  echo "Expected a draft release: $tag" >&2
  exit 1
fi
jq -e --argjson count "${#files[@]}" '(.assets | length) == $count' <<<"$assets" >/dev/null
for file in "${files[@]}"; do
  digest="sha256:$(shasum -a 256 "$file" | cut -d ' ' -f1)"
  jq -e --arg file "$file" --arg digest "$digest" '
    any(.assets[]; .name == $file and .state == "uploaded" and .digest == $digest)
  ' <<<"$assets" >/dev/null
done
gh release edit "$tag" --repo "$release_repo" --draft=false --latest=false
