#!/usr/bin/env bash
set -euo pipefail
sudo mkdir -p /home/runner/.cache/compiler-cache /home/runner/.cargo
sudo chown runner:runner /home/runner/.cache/compiler-cache /home/runner/.cargo
python3 /usr/local/bin/compiler-cache.py --configure
case "$(dpkg --print-architecture)" in
  arm64) exec /usr/local/bin/linux-arm64-runner-entrypoint.sh ;;
  amd64) exec /usr/local/bin/linux-amd64-runner-entrypoint.sh ;;
  *) echo 'Unsupported runner architecture' >&2; exit 1 ;;
esac
