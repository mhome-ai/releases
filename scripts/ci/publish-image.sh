#!/usr/bin/env bash
# Push one architecture of the Host image to Docker Hub.
# Dispatch once with an nlr tag and once with the matching nlx tag.
# latest is published only after both architectures exist.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
source "$HERE/lib.sh"

read_product_tag "${RELEASE_TAG:?}"
[ "$PRODUCT_CHANNEL" = native ] || fail "image publish takes a Native Linux tag such as nlr20261001-01"
case "$PRODUCT_PLATFORM" in
  linux-arm64) arch=arm64 ;;
  linux-x64) arch=amd64 ;;
  *) fail "image publish only accepts linux-arm64 or linux-x64 tags" ;;
esac
[ "$PRODUCT_PLATFORM" = "${WORK_SUFFIX:?}" ] || fail "tag platform $PRODUCT_PLATFORM does not match runner $WORK_SUFFIX"
[ -n "${DOCKERHUB_USERNAME:-}" ] || fail "Missing secret DOCKERHUB_USERNAME"
[ -n "${DOCKERHUB_TOKEN:-}" ] || fail "Missing secret DOCKERHUB_TOKEN"

require_cmd docker gh node

cleanup() {
  docker logout >/dev/null 2>&1 || true
  cleanup_worktree || echo "::warning::release worktree cleanup failed for $WORK_ROOT"
}
trap cleanup EXIT

prepare_product_sources --with-meowcore
compose="${BAYCAT_DIR}/docker/meow-compose.yml"
repo=meowlink/meow
grep -Eq '^[[:space:]]*image:[[:space:]]*meowlink/meow:latest[[:space:]]*$' "$compose" \
  || fail "compose image must be meowlink/meow:latest"

assets="${WORK_ROOT}/image-assets"
rm -rf "$assets"
mkdir -p "$assets"
gh release download "$PRODUCT_RELEASE_TAG" \
  --repo "$GITHUB_RELEASE_REPO" \
  --pattern "host-${PRODUCT_PLATFORM}.tar.gz" \
  --dir "$assets" \
  --clobber
archive="${assets}/host-${PRODUCT_PLATFORM}.tar.gz"
[ -f "$archive" ] || fail "GitHub release $PRODUCT_RELEASE_TAG has no host-${PRODUCT_PLATFORM}.tar.gz"

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
version="$(node -e '
  const fs = require("fs");
  const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).version;
  if (typeof value !== "string" || !value) process.exit(1);
  process.stdout.write(value);
' "$host_dist/component.json")" || fail "Host component.json has no version"
printf '%s\n' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' \
  || fail "Host version must be x.y.z, got $version"

printf '%s\n' "$DOCKERHUB_TOKEN" | docker login --username "$DOCKERHUB_USERNAME" --password-stdin
image="${repo}:${version}-${arch}"
bash "$BAYCAT_DIR/scripts/release/docker/build-image.sh" \
  --host-dist "$host_dist" \
  --meowcore-dir "$MEOWCORE_DIR" \
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
