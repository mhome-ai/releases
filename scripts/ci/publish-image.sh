#!/usr/bin/env bash
# Push one architecture of the Host image to Docker Hub.
# The tag is a published Native Linux release, for example nlr1.0.2 or nlx1.0.3.
# IMAGE_VERSION is the Docker tag, for example 0.1.0.
# latest is published only after both architectures of that version exist.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
source "$HERE/lib.sh"

tag="${RELEASE_TAG:?}"
case "$tag" in
  nlr*) platform=linux-arm64; arch=arm64; asset=host-linux-arm64.tar.gz ;;
  nlx*) platform=linux-x64; arch=amd64; asset=host-linux-amd64.tar.gz ;;
  *) fail "image publish takes an nlr or nlx release tag, got $tag" ;;
esac
[ "$platform" = "${WORK_SUFFIX:?}" ] || fail "tag platform $platform does not match runner $WORK_SUFFIX"
version="${IMAGE_VERSION:?IMAGE_VERSION is required}"
printf '%s\n' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' \
  || fail "IMAGE_VERSION must be x.y.z, got $version"
[ -n "${DOCKERHUB_USERNAME:-}" ] || fail "Missing secret DOCKERHUB_USERNAME"
[ -n "${DOCKERHUB_TOKEN:-}" ] || fail "Missing secret DOCKERHUB_TOKEN"

require_cmd docker gh node git
require_mhome_clone baycat
require_mhome_clone meowcore-rust

cleanup() {
  docker logout >/dev/null 2>&1 || true
  cleanup_worktree || echo "::warning::release worktree cleanup failed for $WORK_ROOT"
}
trap cleanup EXIT

mkdir -p "$WORK_ROOT"
git -C "$MHOME/baycat" fetch --prune origin master
git -C "$MHOME/baycat" worktree add --detach "$WORK_ROOT/baycat" origin/master
pin="$(node -e '
  const fs = require("fs");
  const pin = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).sources.meowcoreRust;
  if (!pin || !/^\d+\.\d+\.\d+$/.test(pin.version || "") || !/^[0-9a-f]{40}$/.test(pin.commit || "")) {
    process.exit(1);
  }
  process.stdout.write(pin.version + " " + pin.commit);
' "$WORK_ROOT/baycat/release/sources/dependencies.json")" || fail "baycat is missing a meowcore pin"
pin_version="${pin%% *}"
pin_commit="${pin#* }"
git -C "$MHOME/meowcore-rust" fetch origin "refs/tags/v${pin_version}:refs/tags/v${pin_version}"
actual="$(git -C "$MHOME/meowcore-rust" rev-parse "v${pin_version}^{commit}")"
[ "$actual" = "$pin_commit" ] || fail "meowcore v${pin_version} is $actual, baycat pins $pin_commit"
git -C "$MHOME/meowcore-rust" worktree add --detach "$WORK_ROOT/meowcore-rust" "$pin_commit"

repo=mhomeai/meow
assets="${WORK_ROOT}/image-assets"
mkdir -p "$assets"
gh release download "$tag" \
  --repo "$GITHUB_RELEASE_REPO" \
  --pattern "$asset" \
  --dir "$assets" \
  --clobber
archive="${assets}/${asset}"
[ -f "$archive" ] || fail "GitHub release $tag has no $asset"

extract="${WORK_ROOT}/host-extract"
mkdir -p "$extract"
tar -xzf "$archive" -C "$extract"
host_bin=
count=0
while IFS= read -r path; do
  host_bin=$path
  count=$((count + 1))
done < <(find "$extract" -type f -path '*/bin/meowhostd')
[ "$count" -eq 1 ] || fail "expected one bin/meowhostd in the Host package, found $count"
chmod +x "$host_bin"
host_dist="$(dirname "$(dirname "$host_bin")")"
[ -f "$host_dist/component.json" ] || fail "Host package has no component.json"

printf '%s\n' "$DOCKERHUB_TOKEN" | docker login --username "$DOCKERHUB_USERNAME" --password-stdin
image="${repo}:${version}-${arch}"
bash "$WORK_ROOT/baycat/scripts/release/docker/build-image.sh" \
  --host-dist "$host_dist" \
  --tag "$image"
docker push "$image"

if [ "$arch" = arm64 ]; then
  other=amd64
else
  other=arm64
fi
if docker manifest inspect "${repo}:${version}-${other}" >/dev/null 2>&1; then
  for name in "$version" latest; do
    docker manifest rm "${repo}:${name}" >/dev/null 2>&1 || true
    docker manifest create "${repo}:${name}" \
      "${repo}:${version}-arm64" \
      "${repo}:${version}-amd64"
    docker manifest annotate "${repo}:${name}" "${repo}:${version}-arm64" --os linux --arch arm64
    docker manifest annotate "${repo}:${name}" "${repo}:${version}-amd64" --os linux --arch amd64
    docker manifest push --purge "${repo}:${name}"
  done
  echo "Published ${repo}:${version} and ${repo}:latest"
else
  echo "Published ${image}. ${repo}:${version} and latest wait for linux/${other}."
fi
