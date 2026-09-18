#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
source "$HERE/lib.sh"

tag="${RELEASE_TAG:?}"
stage="${RELEASE_EXTRA:?RELEASE_EXTRA is the docker stage}"
read_product_tag "$tag"
[ "$PRODUCT_CHANNEL" = "docker" ] || fail "$tag is not a docker product tag"
require_mhome_clone baycat
require_mhome_clone meowcore-rust
require_mhome_clone releases
require_cmd git node cargo curl

[ -n "${DOCKER_DISTRIBUTION_BASE_URL:-}" ] || fail "Missing DOCKER_DISTRIBUTION_BASE_URL"

cleanup() { cleanup_worktree; }
trap cleanup EXIT

prepare_product_sources --with-meowcore --baycat-version-mode independent
cd "$BAYCAT_DIR"

ghcr_login() {
  [ -n "${GH_TOKEN:-}" ] || fail "GH_TOKEN is required for GHCR"
  printf '%s' "$GH_TOKEN" | docker login ghcr.io -u "${GITHUB_ACTOR:-github-actions}" --password-stdin
}

copy_plan_into_tree() {
  local plan="${PLAN_DIR:?PLAN_DIR is required}"
  mkdir -p build
  cp "$plan/docker-release-manifest.json" build/
  cp "$plan/meowctl-release-build-metadata.json" tools/meowctl/release-build-metadata.json
  cp "$plan/docker-catalog-signing-policy.json" tools/meowctl/release-signing-policy.json
  node scripts/release/docker/generate-meowctl-build-metadata.js \
    --version "$PRODUCT_VERSION" \
    --policy "$plan/docker-catalog-signing-policy.json" \
    --verify "$plan/meowctl-release-build-metadata.json"
}

publish_changed_images() {
  local platform="$1" digest_dir="$2"
  mkdir -p "$digest_dir"
  local mapping image output
  for mapping in core:meow-core camera:meow-node-camera matter:meow-node-matter llm:meow-node-llm storage:meow-node-storage; do
    output="${mapping%%:*}"
    image="${mapping#*:}"
    want="$(node -e 'const p=require(process.argv[1]); process.stdout.write(String(p.releaseImages.some(x => x.id === process.argv[2])))' build/docker-release-manifest.json "$image")"
    [ "$want" = "true" ] || continue
    bash scripts/release/docker/docker-publish-release-plan.sh \
      build/docker-release-manifest.json \
      --image "$image" \
      --platform "$platform" \
      --digest-output "$digest_dir/${image}-${platform//\//-}.json"
  done
}

case "$stage" in
  plan)
    require_cmd minisign
    mkdir -p build
    cp release/docker/catalog-signing-policy.json build/docker-catalog-signing-policy.json
    node scripts/release/docker/generate-meowctl-build-metadata.js \
      --version "$PRODUCT_VERSION" \
      --policy build/docker-catalog-signing-policy.json \
      --output build/meowctl-release-build-metadata.json
    catalog_url="${DOCKER_DISTRIBUTION_BASE_URL%/}/docker/stable/catalog.json"
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
      --output build/docker-release-manifest.json \
      "${previous_args[@]}"
    node --test \
      scripts/lib/docker-product-version.test.js \
      scripts/lib/docker-image-state.test.js \
      scripts/release/docker/docker-release-plan.test.js
    bash scripts/release/docker/docker-release-contract.test.sh
    artifact="$WORK_ROOT/artifact"
    mkdir -p "$artifact"
    cp build/docker-release-manifest.json \
      build/docker-catalog-signing-policy.json \
      build/meowctl-release-build-metadata.json \
      build/release-source-provenance.json \
      "$artifact/"
    if [ -f build/previous-docker-catalog/origin-absence-verification-required ]; then
      cp build/previous-docker-catalog/origin-absence-verification-required "$artifact/"
    fi
    if [ -n "${GITHUB_OUTPUT:-}" ]; then
      echo "artifact_dir=$artifact" >> "$GITHUB_OUTPUT"
      echo "version=$PRODUCT_VERSION" >> "$GITHUB_OUTPUT"
      for mapping in core:meow-core camera:meow-node-camera matter:meow-node-matter llm:meow-node-llm storage:meow-node-storage; do
        output="${mapping%%:*}"
        image="${mapping#*:}"
        value="$(node -e 'const p=require(process.argv[1]); process.stdout.write(String(p.releaseImages.some(x => x.id === process.argv[2])))' build/docker-release-manifest.json "$image")"
        echo "publish_${output}=${value}" >> "$GITHUB_OUTPUT"
      done
    fi
    ;;
  linux/amd64|linux/arm64)
    require_cmd docker
    docker version >/dev/null
    copy_plan_into_tree
    ghcr_login
    digest_dir="$BAYCAT_DIR/build/docker-digests"
    publish_changed_images "$stage" "$digest_dir"
    arch="${stage#linux/}"
    mkdir -p "build/meowctl-linux-$arch"
    docker buildx build --platform "$stage" -f docker/meowctl.Dockerfile \
      --output "type=local,dest=build/meowctl-linux-$arch" tools/meowctl
    artifact="$WORK_ROOT/artifact"
    mkdir -p "$artifact/digests" "$artifact/meowctl"
    cp -a "$digest_dir/." "$artifact/digests/"
    cp "build/meowctl-linux-$arch/meowctl" "$artifact/meowctl/"
    [ -n "${GITHUB_OUTPUT:-}" ] && echo "artifact_dir=$artifact" >> "$GITHUB_OUTPUT"
    ;;
  merge)
    require_cmd docker
    copy_plan_into_tree
    mkdir -p build/docker-digests
    cp -a "${AMD64_DIGEST_DIR:?}/." build/docker-digests/
    cp -a "${ARM64_DIGEST_DIR:?}/." build/docker-digests/
    ghcr_login
    for image in meow-core meow-node-camera meow-node-matter meow-node-llm meow-node-storage; do
      amd64="build/docker-digests/${image}-linux-amd64.json"
      arm64="build/docker-digests/${image}-linux-arm64.json"
      [ -f "$amd64" ] || [ -f "$arm64" ] || continue
      files=""
      [ -f "$amd64" ] && files="$amd64"
      [ -f "$arm64" ] && files="${files:+$files,}$arm64"
      bash scripts/release/docker/docker-publish-release-plan.sh \
        build/docker-release-manifest.json \
        --image "$image" \
        --merge-digest-files "$files"
    done
    artifact="$WORK_ROOT/artifact"
    mkdir -p "$artifact"
    cp build/docker-release-manifest.json "$artifact/"
    [ -n "${GITHUB_OUTPUT:-}" ] && echo "artifact_dir=$artifact" >> "$GITHUB_OUTPUT"
    ;;
  publish)
    require_cmd minisign aws docker
    copy_plan_into_tree
    mkdir -p build/meowctl/linux-amd64 build/meowctl/linux-arm64 build
    cp "${MEOWCTL_AMD64:?}" build/meowctl/linux-amd64/meowctl
    cp "${MEOWCTL_ARM64:?}" build/meowctl/linux-arm64/meowctl
    chmod 755 build/meowctl/linux-amd64/meowctl build/meowctl/linux-arm64/meowctl
    cp "${MANIFEST_PATH:?}" build/docker-release-manifest.json
    version="$PRODUCT_VERSION"
    node scripts/release/docker/generate-meowctl-build-metadata.js \
      --version "$version" \
      --policy "$PLAN_DIR/docker-catalog-signing-policy.json" \
      --verify "$PLAN_DIR/meowctl-release-build-metadata.json"
    base="${DOCKER_DISTRIBUTION_BASE_URL%/}/docker/meowctl/${version}"
    amd64_sha="$(sha256sum build/meowctl/linux-amd64/meowctl | awk '{print $1}')"
    arm64_sha="$(sha256sum build/meowctl/linux-arm64/meowctl | awk '{print $1}')"
    amd64_size="$(stat -c '%s' build/meowctl/linux-amd64/meowctl 2>/dev/null || stat -f '%z' build/meowctl/linux-amd64/meowctl)"
    arm64_size="$(stat -c '%s' build/meowctl/linux-arm64/meowctl 2>/dev/null || stat -f '%z' build/meowctl/linux-arm64/meowctl)"
    node -e '
      const fs = require("fs");
      const [version, base, amd64Sha, amd64Size, arm64Sha, arm64Size] = process.argv.slice(1);
      const manifest = { version, assets: {
        "linux-amd64": { url: `${base}/linux-amd64/meowctl`, sha256: amd64Sha, size: Number(amd64Size) },
        "linux-arm64": { url: `${base}/linux-arm64/meowctl`, sha256: arm64Sha, size: Number(arm64Size) }
      }};
      fs.mkdirSync("build/meowctl", { recursive: true });
      fs.writeFileSync("build/meowctl/manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
    ' "$version" "$base" "$amd64_sha" "$amd64_size" "$arm64_sha" "$arm64_size"
    node scripts/release/docker/render-docker-install.js \
      --template scripts/release/install-meow-docker.sh \
      --manifest build/meowctl/manifest.json \
      --output build/docker-install.sh
    node scripts/release/docker/generate-docker-catalog.js \
      --plan build/docker-release-manifest.json \
      --source-provenance "$PLAN_DIR/release-source-provenance.json" \
      --output build/docker-catalog.json
    node scripts/release/docker/generate-docker-bootstrap.js \
      --catalog build/docker-catalog.json \
      --catalog-url "${DOCKER_DISTRIBUTION_BASE_URL%/}/docker/catalogs/${version}/catalog.json" \
      --meowctl-manifest build/meowctl/manifest.json \
      --source-provenance "$PLAN_DIR/release-source-provenance.json" \
      --published-at "$(date -u +'%Y-%m-%dT%H:%M:%S.000Z')" \
      --output build/docker-bootstrap.json
    bash scripts/release/docker/sign-docker-catalog.sh \
      --version "$version" --metadata build/docker-catalog.json \
      --policy "$PLAN_DIR/docker-catalog-signing-policy.json"
    bash scripts/release/docker/sign-docker-catalog.sh \
      --version "$version" --metadata build/docker-bootstrap.json \
      --policy "$PLAN_DIR/docker-catalog-signing-policy.json"
    node scripts/release/docker/generate-docker-catalog-bundle.js \
      --catalog build/docker-catalog.json --output build/docker-catalog.bundle.json
    node scripts/release/docker/generate-docker-catalog-bundle.js \
      --bootstrap build/docker-bootstrap.json --output build/docker-bootstrap.bundle.json
    [ -n "${DOCKER_DISTRIBUTION_PUBLISH_ROLE_ARN:-}" ] || fail "Missing DOCKER_DISTRIBUTION_PUBLISH_ROLE_ARN"
    [ -n "${DOCKER_DISTRIBUTION_BUCKET:-}" ] || fail "Missing DOCKER_DISTRIBUTION_BUCKET"
    assume_aws_role "$DOCKER_DISTRIBUTION_PUBLISH_ROLE_ARN"
    if [ -f "$PLAN_DIR/origin-absence-verification-required" ]; then
      count="$(aws s3api list-objects-v2 --bucket "$DOCKER_DISTRIBUTION_BUCKET" --prefix docker/stable/ --max-keys 1 --query KeyCount --output text)"
      [ "$count" = "0" ] || fail "CloudFront hid an existing stable Docker Catalog"
    fi
    prefix="docker/meowctl/${version}"
    publish_immutable_s3 build/meowctl/linux-amd64/meowctl "$DOCKER_DISTRIBUTION_BUCKET" "$prefix/linux-amd64/meowctl" application/octet-stream
    publish_immutable_s3 build/meowctl/linux-arm64/meowctl "$DOCKER_DISTRIBUTION_BUCKET" "$prefix/linux-arm64/meowctl" application/octet-stream
    publish_immutable_s3 build/meowctl/manifest.json "$DOCKER_DISTRIBUTION_BUCKET" "$prefix/manifest.json" application/json
    publish_immutable_s3 build/docker-catalog.json.minisig "$DOCKER_DISTRIBUTION_BUCKET" "docker/catalogs/${version}/catalog.json.minisig" application/octet-stream
    for signature in build/docker-catalog.json.minisig.*; do
      [ -f "$signature" ] || continue
      key_id="${signature##*.minisig.}"
      publish_immutable_s3 "$signature" "$DOCKER_DISTRIBUTION_BUCKET" "docker/catalogs/${version}/catalog.json.minisig.${key_id}" application/octet-stream
    done
    publish_immutable_s3 build/docker-catalog.bundle.json "$DOCKER_DISTRIBUTION_BUCKET" "docker/catalogs/${version}/catalog.bundle.json" application/json
    publish_immutable_s3 build/docker-catalog.json "$DOCKER_DISTRIBUTION_BUCKET" "docker/catalogs/${version}/catalog.json" application/json
    publish_immutable_s3 build/docker-install.sh "$DOCKER_DISTRIBUTION_BUCKET" "docker/versions/${version}/install.sh" "text/x-shellscript; charset=utf-8"
    base="${DOCKER_DISTRIBUTION_BASE_URL%/}"
    temporary="$(mktemp -d)"
    curl -fsSL --retry 5 "$base/docker/catalogs/${version}/catalog.json" -o "$temporary/catalog.json"
    curl -fsSL --retry 5 "$base/docker/catalogs/${version}/catalog.json.minisig" -o "$temporary/catalog.json.minisig"
    curl -fsSL --retry 5 "$base/docker/catalogs/${version}/catalog.bundle.json" -o "$temporary/catalog.bundle.json"
    cmp -s build/docker-catalog.json "$temporary/catalog.json"
    cmp -s build/docker-catalog.json.minisig "$temporary/catalog.json.minisig"
    cmp -s build/docker-catalog.bundle.json "$temporary/catalog.bundle.json"
    curl -fsSL --retry 5 "$base/docker/meowctl/${version}/linux-amd64/meowctl" -o "$temporary/meowctl-amd64"
    curl -fsSL --retry 5 "$base/docker/meowctl/${version}/linux-arm64/meowctl" -o "$temporary/meowctl-arm64"
    curl -fsSL --retry 5 "$base/docker/versions/${version}/install.sh" -o "$temporary/install.sh"
    cmp -s build/meowctl/linux-amd64/meowctl "$temporary/meowctl-amd64"
    cmp -s build/meowctl/linux-arm64/meowctl "$temporary/meowctl-arm64"
    cmp -s build/docker-install.sh "$temporary/install.sh"
    aws s3 cp build/docker-catalog.json.minisig "s3://${DOCKER_DISTRIBUTION_BUCKET}/docker/stable/catalog.json.minisig" \
      --content-type application/octet-stream --cache-control "no-cache,max-age=0"
    for signature in build/docker-catalog.json.minisig.*; do
      [ -f "$signature" ] || continue
      key_id="${signature##*.minisig.}"
      aws s3 cp "$signature" "s3://${DOCKER_DISTRIBUTION_BUCKET}/docker/stable/catalog.json.minisig.${key_id}" \
        --content-type application/octet-stream --cache-control "no-cache,max-age=0"
    done
    aws s3 cp build/docker-catalog.json "s3://${DOCKER_DISTRIBUTION_BUCKET}/docker/stable/catalog.json" \
      --content-type application/json --cache-control "no-cache,max-age=0"
    aws s3 cp build/docker-catalog.bundle.json "s3://${DOCKER_DISTRIBUTION_BUCKET}/docker/stable/catalog.bundle.json" \
      --content-type application/json --cache-control "no-cache,max-age=0"
    aws s3 cp build/docker-bootstrap.json.minisig "s3://${DOCKER_DISTRIBUTION_BUCKET}/docker/stable/bootstrap.json.minisig" \
      --content-type application/octet-stream --cache-control "no-cache,max-age=0"
    for signature in build/docker-bootstrap.json.minisig.*; do
      [ -f "$signature" ] || continue
      key_id="${signature##*.minisig.}"
      aws s3 cp "$signature" "s3://${DOCKER_DISTRIBUTION_BUCKET}/docker/stable/bootstrap.json.minisig.${key_id}" \
        --content-type application/octet-stream --cache-control "no-cache,max-age=0"
    done
    aws s3 cp build/docker-bootstrap.bundle.json "s3://${DOCKER_DISTRIBUTION_BUCKET}/docker/stable/bootstrap.bundle.json" \
      --content-type application/json --cache-control "no-cache,max-age=0"
    aws s3 cp build/docker-bootstrap.json "s3://${DOCKER_DISTRIBUTION_BUCKET}/docker/stable/bootstrap.json" \
      --content-type application/json --cache-control "no-cache,max-age=0"
    aws s3 cp build/docker-install.sh "s3://${DOCKER_DISTRIBUTION_BUCKET}/docker/install.sh" \
      --content-type "text/x-shellscript; charset=utf-8" --cache-control "no-cache,max-age=0"
    ;;
  *) fail "unknown docker stage $stage" ;;
esac
