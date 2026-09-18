#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
source "$HERE/lib.sh"

tag="${RELEASE_TAG:?}"
read_product_tag "$tag"
[ "$PRODUCT_CHANNEL" = "docker" ] || fail "$tag is not a docker product tag"
require_mhome_clone baycat
require_mhome_clone meowcore-rust
require_mhome_clone releases
require_cmd git node cargo curl docker minisign aws
[ -n "${DOCKER_DISTRIBUTION_BASE_URL:-}" ] || fail "Missing DOCKER_DISTRIBUTION_BASE_URL"
[ -n "${DOCKER_DISTRIBUTION_PUBLISH_ROLE_ARN:-}" ] || fail "Missing DOCKER_DISTRIBUTION_PUBLISH_ROLE_ARN"
[ -n "${DOCKER_DISTRIBUTION_BUCKET:-}" ] || fail "Missing DOCKER_DISTRIBUTION_BUCKET"

platform="$PRODUCT_PLATFORM"
case "$platform" in
  linux-arm64)
    docker_platform="linux/arm64"
    sibling_docker_platform="linux/amd64"
    ;;
  linux-amd64)
    docker_platform="linux/amd64"
    sibling_docker_platform="linux/arm64"
    ;;
  *) fail "unsupported docker platform $platform" ;;
esac
arch="${platform#linux-}"
version="$PRODUCT_VERSION"
base_url="${DOCKER_DISTRIBUTION_BASE_URL%/}"
stable_prefix="docker/stable/${platform}"
catalogs_prefix="docker/catalogs/${version}/${platform}"

cleanup() {
  cleanup_worktree || echo "::warning::release worktree cleanup failed for $WORK_ROOT"
}
trap cleanup EXIT

prepare_product_sources --with-meowcore --baycat-version-mode independent
cd "$BAYCAT_DIR"

ghcr_login() {
  [ -n "${GH_TOKEN:-}" ] || fail "GH_TOKEN is required for GHCR"
  printf '%s' "$GH_TOKEN" | docker login ghcr.io -u "${GITHUB_ACTOR:-github-actions}" --password-stdin
}

image_ref_exists() {
  docker buildx imagetools inspect "$1" >/dev/null 2>&1
}

digest_of_ref() {
  local output digest attempt
  for attempt in 1 2 3 4 5 6 7 8 9 10; do
    output="$(docker buildx imagetools inspect "$1" 2>/dev/null || true)"
    digest="$(awk '/^Digest:/ { print $2; exit }' <<< "$output")"
    if [[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]]; then
      printf '%s\n' "$digest"
      return 0
    fi
    sleep 3
  done
  return 1
}

publish_versioned_catalog() {
  publish_immutable_s3 build/docker-catalog.json.minisig "$DOCKER_DISTRIBUTION_BUCKET" \
    "${catalogs_prefix}/catalog.json.minisig" application/octet-stream
  for signature in build/docker-catalog.json.minisig.*; do
    [ -f "$signature" ] || continue
    key_id="${signature##*.minisig.}"
    publish_immutable_s3 "$signature" "$DOCKER_DISTRIBUTION_BUCKET" \
      "${catalogs_prefix}/catalog.json.minisig.${key_id}" application/octet-stream
  done
  publish_immutable_s3 build/docker-catalog.bundle.json "$DOCKER_DISTRIBUTION_BUCKET" \
    "${catalogs_prefix}/catalog.bundle.json" application/json
  publish_immutable_s3 build/docker-catalog.json "$DOCKER_DISTRIBUTION_BUCKET" \
    "${catalogs_prefix}/catalog.json" application/json
}

promote_stable_object() {
  local source="$1" key="$2" content_type="$3"
  aws s3 cp "$source" "s3://${DOCKER_DISTRIBUTION_BUCKET}/${key}" \
    --content-type "$content_type" --cache-control "no-cache,max-age=0"
}

promote_stable_signed() {
  local source_json="$1" name="$2"
  promote_stable_object "${source_json}.minisig" "${stable_prefix}/${name}.minisig" application/octet-stream
  for signature in "${source_json}.minisig."*; do
    [ -f "$signature" ] || continue
    key_id="${signature##*.minisig.}"
    promote_stable_object "$signature" "${stable_prefix}/${name}.minisig.${key_id}" application/octet-stream
  done
  promote_stable_object "$source_json" "${stable_prefix}/${name}" application/json
  promote_stable_object "${source_json%.json}.bundle.json" "${stable_prefix}/${name%.json}.bundle.json" application/json
}

merge_multiarch_if_sibling_present() {
  local sibling_ready=1 image_id image_name image_version sibling_ref sibling_digest
  while IFS=$'\t' read -r image_id image_name image_version; do
    [ -n "$image_id" ] || continue
    sibling_ref="${image_name}:${image_version}-${sibling_docker_platform//\//-}"
    if ! image_ref_exists "$sibling_ref"; then
      echo "sibling image $sibling_ref is not published yet; skipping optional multi-arch tag"
      sibling_ready=0
      continue
    fi
    sibling_digest="$(digest_of_ref "$sibling_ref")" || fail "failed to resolve $sibling_ref"
    node -e '
      const fs = require("fs");
      const [output, id, image, version, platform, digest] = process.argv.slice(1);
      fs.writeFileSync(output, `${JSON.stringify({ id, image, version, platform, digest }, null, 2)}\n`);
    ' "$digest_dir/${image_id}-${sibling_docker_platform//\//-}.json" \
      "$image_id" "$image_name" "$image_version" "$sibling_docker_platform" "$sibling_digest"
  done < <(
    node -e '
      const plan = require(process.argv[1]);
      for (const image of plan.releaseImages || []) {
        process.stdout.write(`${image.id}\t${image.image}\t${image.version}\n`);
      }
    ' build/docker-release-manifest.json
  )
  [ "$sibling_ready" -eq 1 ] || return 0
  while IFS=$'\t' read -r image_id image_name image_version; do
    [ -n "$image_id" ] || continue
    bash scripts/release/docker/docker-publish-release-plan.sh \
      build/docker-release-manifest.json \
      --image "$image_id" \
      --merge-digest-files "$digest_dir/${image_id}-${docker_platform//\//-}.json,$digest_dir/${image_id}-${sibling_docker_platform//\//-}.json"
  done < <(
    node -e '
      const plan = require(process.argv[1]);
      for (const image of plan.releaseImages || []) {
        process.stdout.write(`${image.id}\t${image.image}\t${image.version}\n`);
      }
    ' build/docker-release-manifest.json
  )
}

require_cmd docker
docker version >/dev/null
mkdir -p build
cp release/docker/catalog-signing-policy.json build/docker-catalog-signing-policy.json
node scripts/release/docker/generate-meowctl-build-metadata.js \
  --version "$PRODUCT_VERSION" \
  --policy build/docker-catalog-signing-policy.json \
  --output build/meowctl-release-build-metadata.json
cp build/meowctl-release-build-metadata.json tools/meowctl/release-build-metadata.json
cp build/docker-catalog-signing-policy.json tools/meowctl/release-signing-policy.json
catalog_url="${base_url}/${stable_prefix}/catalog.json"
bash scripts/release/docker/fetch-verified-docker-catalog.sh \
  --policy build/docker-catalog-signing-policy.json \
  "$catalog_url" build/previous-docker-catalog
cargo metadata --manifest-path ../meowcore-rust/Cargo.toml --format-version 1 --no-deps >/dev/null
previous_args=()
if [ -f build/previous-docker-catalog/catalog.json ]; then
  previous_args+=(--previous-catalog build/previous-docker-catalog/catalog.json)
fi
node scripts/release/docker/docker-release-plan.js \
  --version "$PRODUCT_VERSION" \
  --platform "$platform" \
  --output build/docker-release-manifest.json \
  "${previous_args[@]}"
node --test \
  scripts/lib/docker-product-version.test.js \
  scripts/lib/docker-image-state.test.js \
  scripts/release/docker/docker-release-plan.test.js
bash scripts/release/docker/docker-release-contract.test.sh

ghcr_login
digest_dir="$BAYCAT_DIR/build/docker-digests"
mkdir -p "$digest_dir"
while IFS=$'\t' read -r image_id image_name image_version; do
  [ -n "$image_id" ] || continue
  bash scripts/release/docker/docker-publish-release-plan.sh \
    build/docker-release-manifest.json \
    --image "$image_id" \
    --platform "$docker_platform" \
    --digest-output "$digest_dir/${image_id}-${docker_platform//\//-}.json"
  digest="$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).digest)' "$digest_dir/${image_id}-${docker_platform//\//-}.json")"
  docker buildx imagetools create \
    -t "${image_name}:${image_version}-${docker_platform//\//-}" \
    "${image_name}@${digest}"
done < <(
  node -e '
    const plan = require(process.argv[1]);
    for (const image of plan.releaseImages || []) {
      process.stdout.write(`${image.id}\t${image.image}\t${image.version}\n`);
    }
  ' build/docker-release-manifest.json
)

node -e '
const fs = require("fs");
const [planPath, digestDir, platformSlug] = process.argv.slice(1);
const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
plan.publishedImages = plan.publishedImages || {};
for (const image of plan.releaseImages || []) {
  const published = JSON.parse(fs.readFileSync(`${digestDir}/${image.id}-${platformSlug}.json`, "utf8"));
  if (published.id !== image.id || !/^sha256:[0-9a-f]{64}$/.test(published.digest || "")) {
    throw new Error(`invalid published digest for ${image.id}`);
  }
  plan.publishedImages[image.id] = {
    digest: published.digest,
    platform: published.platform,
  };
}
fs.writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`);
' build/docker-release-manifest.json "$digest_dir" "${docker_platform//\//-}"

mkdir -p "build/meowctl-linux-$arch" "build/meowctl/linux-$arch"
docker buildx build --platform "$docker_platform" -f docker/meowctl.Dockerfile \
  --output "type=local,dest=build/meowctl-linux-$arch" tools/meowctl
cp "build/meowctl-linux-$arch/meowctl" "build/meowctl/linux-$arch/meowctl"
chmod 755 "build/meowctl/linux-$arch/meowctl"

assume_aws_role "$DOCKER_DISTRIBUTION_PUBLISH_ROLE_ARN"
if [ -f build/previous-docker-catalog/origin-absence-verification-required ]; then
  count="$(aws s3api list-objects-v2 --bucket "$DOCKER_DISTRIBUTION_BUCKET" --prefix "${stable_prefix}/" --max-keys 1 --query KeyCount --output text)"
  [ "$count" = "0" ] || fail "CloudFront hid an existing stable Docker Catalog for ${platform}"
fi
publish_immutable_s3 "build/meowctl/linux-$arch/meowctl" \
  "$DOCKER_DISTRIBUTION_BUCKET" \
  "docker/meowctl/${version}/linux-${arch}/meowctl" \
  application/octet-stream

meowctl_url="${base_url}/docker/meowctl/${version}/linux-${arch}/meowctl"
meowctl_sha="$(sha256sum "build/meowctl/linux-$arch/meowctl" | awk '{print $1}')"
meowctl_size="$(stat -c '%s' "build/meowctl/linux-$arch/meowctl" 2>/dev/null || stat -f '%z' "build/meowctl/linux-$arch/meowctl")"
node -e '
  const fs = require("fs");
  const [version, platform, url, sha256, size] = process.argv.slice(1);
  const manifest = {
    version,
    platform,
    assets: {
      [platform]: { url, sha256, size: Number(size) },
    },
  };
  fs.mkdirSync("build/meowctl", { recursive: true });
  fs.writeFileSync("build/meowctl/manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
' "$version" "$platform" "$meowctl_url" "$meowctl_sha" "$meowctl_size"
node scripts/release/docker/render-docker-install.js \
  --template scripts/release/install-meow-docker.sh \
  --manifest build/meowctl/manifest.json \
  --output build/docker-install.sh
node scripts/release/docker/generate-docker-catalog.js \
  --plan build/docker-release-manifest.json \
  --platform "$platform" \
  --source-provenance build/release-source-provenance.json \
  --output build/docker-catalog.json
node scripts/release/docker/generate-docker-bootstrap.js \
  --catalog build/docker-catalog.json \
  --platform "$platform" \
  --catalog-url "${base_url}/${catalogs_prefix}/catalog.json" \
  --meowctl-manifest build/meowctl/manifest.json \
  --source-provenance build/release-source-provenance.json \
  --published-at "$(date -u +'%Y-%m-%dT%H:%M:%S.000Z')" \
  --output build/docker-bootstrap.json
bash scripts/release/docker/sign-docker-catalog.sh \
  --version "$version" --metadata build/docker-catalog.json \
  --policy build/docker-catalog-signing-policy.json
bash scripts/release/docker/sign-docker-catalog.sh \
  --version "$version" --metadata build/docker-bootstrap.json \
  --policy build/docker-catalog-signing-policy.json
node scripts/release/docker/generate-docker-catalog-bundle.js \
  --catalog build/docker-catalog.json --output build/docker-catalog.bundle.json
node scripts/release/docker/generate-docker-catalog-bundle.js \
  --bootstrap build/docker-bootstrap.json --output build/docker-bootstrap.bundle.json

publish_versioned_catalog
publish_immutable_s3 build/docker-install.sh "$DOCKER_DISTRIBUTION_BUCKET" \
  "docker/versions/${version}/${platform}/install.sh" "text/x-shellscript; charset=utf-8"

temporary="$(mktemp -d)"
curl -fsSL --retry 5 "$base_url/${catalogs_prefix}/catalog.json" -o "$temporary/catalog.json"
curl -fsSL --retry 5 "$base_url/${catalogs_prefix}/catalog.json.minisig" -o "$temporary/catalog.json.minisig"
curl -fsSL --retry 5 "$base_url/${catalogs_prefix}/catalog.bundle.json" -o "$temporary/catalog.bundle.json"
cmp -s build/docker-catalog.json "$temporary/catalog.json"
cmp -s build/docker-catalog.json.minisig "$temporary/catalog.json.minisig"
cmp -s build/docker-catalog.bundle.json "$temporary/catalog.bundle.json"
curl -fsSL --retry 5 "$meowctl_url" -o "$temporary/meowctl"
curl -fsSL --retry 5 "$base_url/docker/versions/${version}/${platform}/install.sh" -o "$temporary/install.sh"
cmp -s "build/meowctl/linux-$arch/meowctl" "$temporary/meowctl"
cmp -s build/docker-install.sh "$temporary/install.sh"

promote_stable_signed build/docker-catalog.json catalog.json
promote_stable_object build/docker-install.sh "${stable_prefix}/install.sh" "text/x-shellscript; charset=utf-8"
promote_stable_object scripts/release/install-meow-docker-detect.sh docker/install.sh \
  "text/x-shellscript; charset=utf-8"
promote_stable_signed build/docker-bootstrap.json bootstrap.json

if ! merge_multiarch_if_sibling_present; then
  echo "::warning::optional multi-arch image:version merge failed; ${platform} Catalog is already published"
fi
