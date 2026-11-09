#!/usr/bin/env bash
set -euo pipefail
python3 /usr/local/bin/compiler-cache.py --phase before
exec /usr/local/bin/job-started.sh
