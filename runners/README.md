# Linux native builders

Docker recipes for the GitHub Actions runners that pack Baycat Linux natives
into this public `mhome-ai/releases` bucket.

| Directory | Labels | Host |
|---|---|---|
| `linux-arm64/` | `Linux,ARM64,release-linux-arm64` | Native ARM64 Docker (Apple Silicon or ARM Linux) |
| `linux-amd64/` | `Linux,AMD64,release-linux-amd64` | amd64 Docker. On Apple Silicon this is Rosetta userspace, not QEMU |

Both can stay up on the same Apple Silicon Docker host. They use different
compose projects, labels, and named volumes.

This is only source. `docker compose` identity is the `name:` in each
`compose.yaml`. Already-running containers and their volumes stay put when
these files move. On a new machine, clone this repo and start a new pair of
containers there; do not share `.env` or volumes across machines.

`.env` is local operator identity (runner name + registration token) and is
gitignored. Tokens are only needed the first time a Docker volume has no
`.runner` file.
