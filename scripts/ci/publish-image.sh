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
  nlx*) platform=linux-x64; arch=amd64; asset=host-linux-x64.tar.gz ;;
  *) fail "image publish takes an nlr or nlx release tag, got $tag" ;;
esac
[ "$platform" = "${WORK_SUFFIX:?}" ] || fail "tag platform $platform does not match runner $WORK_SUFFIX"
version="${IMAGE_VERSION:?IMAGE_VERSION is required}"
printf '%s\n' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' \
  || fail "IMAGE_VERSION must be x.y.z, got $version"
[ -n "${DOCKERHUB_USERNAME:-}" ] || fail "Missing secret DOCKERHUB_USERNAME"
[ -n "${DOCKERHUB_TOKEN:-}" ] || fail "Missing secret DOCKERHUB_TOKEN"

require_cmd docker gh node git curl
require_mhome_clone baycat

cleanup() {
  docker logout >/dev/null 2>&1 || true
  cleanup_worktree || echo "::warning::release worktree cleanup failed for $WORK_ROOT"
}
trap cleanup EXIT

mkdir -p "$WORK_ROOT"
git -C "$MHOME/baycat" fetch --prune origin master
git -C "$MHOME/baycat" worktree add --detach "$WORK_ROOT/baycat" origin/master

repo=mhomeai/meow-host
assets="${WORK_ROOT}/image-assets"
mkdir -p "$assets"
archive="${assets}/${asset}"
asset_url="$(gh api "repos/${GITHUB_RELEASE_REPO}/releases/tags/${tag}" \
  --jq ".assets[] | select(.name==\"${asset}\") | .url")"
[ -n "$asset_url" ] || fail "GitHub release $tag has no $asset"
curl --fail --location --retry 8 --retry-all-errors --retry-delay 2 \
  --header "Accept: application/octet-stream" \
  --header "Authorization: Bearer ${GH_TOKEN}" \
  --output "$archive" \
  "$asset_url"

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
