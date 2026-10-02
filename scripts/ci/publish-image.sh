#!/usr/bin/env bash
# Push the Host image for the Linux native release that just finished.
# The Docker tag is that release version. latest is published only after both
# architectures of the same version exist.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
source "$HERE/lib.sh"

tag="${RELEASE_TAG:?}"
read_product_tag "$tag"
case "$PRODUCT_PLATFORM" in
  linux-arm64) arch=arm64; asset=host-linux-arm64.tar.gz ;;
  linux-x64) arch=amd64; asset=host-linux-x64.tar.gz ;;
  *) fail "Host image publish follows a Linux native release, got $PRODUCT_PLATFORM" ;;
esac
[ "$PRODUCT_PLATFORM" = "${WORK_SUFFIX:?}" ] || fail "tag platform $PRODUCT_PLATFORM does not match runner $WORK_SUFFIX"
version="$PRODUCT_VERSION"
printf '%s\n' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' \
  || fail "native release version must be x.y.z, got $version"
[ -n "${DOCKERHUB_USERNAME:-}" ] || fail "Missing secret DOCKERHUB_USERNAME"
[ -n "${DOCKERHUB_TOKEN:-}" ] || fail "Missing secret DOCKERHUB_TOKEN"
[ -n "${BAYCAT_DIR:-}" ] || fail "BAYCAT_DIR is required"
require_cmd docker

archive="${BAYCAT_DIR}/build/native-runtime-assets/${asset}"
[ -f "$archive" ] || fail "missing Host package $archive"

cleanup() {
  docker logout >/dev/null 2>&1 || true
}
trap cleanup EXIT

extract="${WORK_ROOT}/host-extract"
rm -rf "$extract"
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
repo=mhomeai/meow-host
image="${repo}:${version}-${arch}"
bash "$BAYCAT_DIR/scripts/release/docker/build-image.sh" \
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
