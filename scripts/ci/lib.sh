#!/usr/bin/env bash
set -euo pipefail

CI_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MHOME="${MHOME_ROOT:-$HOME/.mhome}"
WORK_ID="${WORK_ID:-${GITHUB_RUN_ID:-local}-${GITHUB_JOB:-shell}-${GITHUB_RUN_ATTEMPT:-1}}"
WORK_ROOT="${WORK_ROOT:-$MHOME/work/$WORK_ID}"
RELEASES_DIR="${RELEASES_DIR:-$WORK_ROOT/releases}"
GITHUB_RELEASE_REPO="${GITHUB_REPOSITORY:-mhome-ai/releases}"

# install.mhome.ai public coordinates. Role ARNs and APPLE_TEAM_ID come from
# org GitHub Variables.
AWS_REGION="${AWS_REGION:-us-east-1}"
INSTALL_DISTRIBUTION_BUCKET="${INSTALL_DISTRIBUTION_BUCKET:-mhome-install-distribution}"
DOCKER_DISTRIBUTION_BASE_URL="${DOCKER_DISTRIBUTION_BASE_URL:-https://install.mhome.ai}"
DOCKER_DISTRIBUTION_BUCKET="${DOCKER_DISTRIBUTION_BUCKET:-$INSTALL_DISTRIBUTION_BUCKET}"
NATIVE_INSTALL_SCRIPT_BUCKET="${NATIVE_INSTALL_SCRIPT_BUCKET:-$INSTALL_DISTRIBUTION_BUCKET}"
RUNTIME_CATALOG_BUCKET="${RUNTIME_CATALOG_BUCKET:-$INSTALL_DISTRIBUTION_BUCKET}"
export AWS_REGION INSTALL_DISTRIBUTION_BUCKET \
  DOCKER_DISTRIBUTION_BASE_URL DOCKER_DISTRIBUTION_BUCKET \
  NATIVE_INSTALL_SCRIPT_BUCKET RUNTIME_CATALOG_BUCKET

fail() {
  echo "::error::$*" >&2
  exit 1
}

require_cmd() {
  local name
  for name in "$@"; do
    command -v "$name" >/dev/null 2>&1 || fail "runner is missing $name; provision this machine"
  done
}

require_mhome_clone() {
  local name="$1"
  [ -e "$MHOME/$name/.git" ] || fail "runner is missing $MHOME/$name; provision this machine"
}

read_product_tag() {
  local tag="$1" line
  unset PRODUCT_CHANNEL PRODUCT_PREFIX PRODUCT_PLATFORM PRODUCT_VERSION PRODUCT_SOURCE_TAG PRODUCT_RELEASE_TAG
  while IFS= read -r line; do
    case "$line" in
      channel=*) PRODUCT_CHANNEL="${line#channel=}" ;;
      prefix=*) PRODUCT_PREFIX="${line#prefix=}" ;;
      platform=*) PRODUCT_PLATFORM="${line#platform=}" ;;
      version=*) PRODUCT_VERSION="${line#version=}" ;;
      sourceTag=*) PRODUCT_SOURCE_TAG="${line#sourceTag=}" ;;
      releaseTag=*) PRODUCT_RELEASE_TAG="${line#releaseTag=}" ;;
    esac
  done < <(node "$CI_ROOT/resolve-product-tag.js" --ref "$tag")
  [ -n "${PRODUCT_VERSION:-}" ] || fail "could not parse product tag $tag"
}

prepare_product_sources() {
  local extra=() mode="match" out
  while [ $# -gt 0 ]; do
    case "$1" in
      --with-meowcore|--with-pallas) extra+=("$1") ;;
      --baycat-version-mode) mode="${2:?}"; shift ;;
      *) fail "unknown prepare argument: $1" ;;
    esac
    shift
  done
  out="$(mktemp)"
  node "$CI_ROOT/prepare-release-sources.js" \
    --version "$PRODUCT_VERSION" \
    --work-id "$WORK_ID" \
    --baycat-version-mode "$mode" \
    "${extra[@]}" >"$out"
  while IFS= read -r line; do
    case "$line" in
      baycat_dir=*) BAYCAT_DIR="${line#baycat_dir=}" ;;
      baycat_revision=*) BAYCAT_REVISION="${line#baycat_revision=}" ;;
      meowcore_dir=*) MEOWCORE_DIR="${line#meowcore_dir=}" ;;
      pallas_dir=*) PALLAS_DIR="${line#pallas_dir=}" ;;
      source_root=*) SOURCE_ROOT="${line#source_root=}" ;;
    esac
  done < "$out"
  rm -f "$out"
  [ -n "${BAYCAT_DIR:-}" ] || fail "prepare-release-sources.js did not write baycat_dir"
}

cleanup_worktree() {
  node "$CI_ROOT/cleanup-release-sources.js" "$WORK_ROOT"
}

assume_aws_role() {
  local role="${1:-}"
  local region="${AWS_REGION:-us-east-1}"
  [ -n "$role" ] || fail "missing AWS role ARN"
  [ -n "${ACTIONS_ID_TOKEN_REQUEST_URL:-}" ] || fail "GitHub OIDC token is not available"
  require_cmd curl aws node
  local token creds
  token="$(curl -fsSL \
    -H "Authorization: bearer ${ACTIONS_ID_TOKEN_REQUEST_TOKEN}" \
    "${ACTIONS_ID_TOKEN_REQUEST_URL}&audience=sts.amazonaws.com" \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{process.stdout.write(JSON.parse(s).value)})')"
  creds="$(aws sts assume-role-with-web-identity \
    --role-arn "$role" \
    --role-session-name "gha-${GITHUB_RUN_ID:-local}-${GITHUB_JOB:-job}" \
    --web-identity-token "$token" \
    --duration-seconds 3600 \
    --query 'Credentials.[AccessKeyId,SecretAccessKey,SessionToken]' \
    --output text)"
  export AWS_ACCESS_KEY_ID
  export AWS_SECRET_ACCESS_KEY
  export AWS_SESSION_TOKEN
  AWS_ACCESS_KEY_ID="$(printf '%s\n' "$creds" | awk '{print $1}')"
  AWS_SECRET_ACCESS_KEY="$(printf '%s\n' "$creds" | awk '{print $2}')"
  AWS_SESSION_TOKEN="$(printf '%s\n' "$creds" | awk '{print $3}')"
  export AWS_DEFAULT_REGION="$region"
}

publish_immutable_s3() {
  local source="$1" bucket="$2" key="$3" content_type="$4"
  local existing error
  existing="$(mktemp)"
  error="$(mktemp)"
  if aws s3api head-object --bucket "$bucket" --key "$key" >/dev/null 2>"$error"; then
    aws s3 cp "s3://${bucket}/${key}" "$existing" --only-show-errors
    cmp -s "$source" "$existing" || fail "Immutable object differs: s3://${bucket}/${key}"
    rm -f "$existing" "$error"
    return
  fi
  grep -Eq '404|Not Found|NoSuchKey' "$error" || { cat "$error" >&2; fail "head-object failed for s3://${bucket}/${key}"; }
  rm -f "$existing" "$error"
  aws s3 cp "$source" "s3://${bucket}/${key}" \
    --content-type "$content_type" \
    --cache-control "public,max-age=31536000,immutable"
}
