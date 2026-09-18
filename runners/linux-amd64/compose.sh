#!/usr/bin/env bash
# Run docker compose for this template with the sibling gitignored .env.
set -euo pipefail

cd "$(dirname "$0")"
ENV_FILE="${LINUX_AMD64_RUNNER_ENV:-.env}"
if [ ! -f "$ENV_FILE" ]; then
  echo "Missing ${ENV_FILE}" >&2
  echo "Copy .env.example to .env in this directory and set RUNNER_URL, RUNNER_NAME, RUNNER_TOKEN." >&2
  exit 1
fi
exec docker compose --env-file "$ENV_FILE" "$@"
