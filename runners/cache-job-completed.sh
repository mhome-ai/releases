#!/usr/bin/env bash
set -euo pipefail
python3 /usr/local/bin/compiler-cache.py --phase after
exec /usr/local/bin/job-completed.sh
