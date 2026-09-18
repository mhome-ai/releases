#!/usr/bin/env bash
# Run docker compose for this template with the sibling gitignored .env.
set -euo pipefail

cd "$(dirname "$0")"
if [ ! -f .env ]; then
  echo "Missing .env" >&2
  echo "Copy .env.example to .env in this directory and set RUNNER_TOKEN." >&2
  exit 1
fi
exec docker compose --env-file .env "$@"
