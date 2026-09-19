# Linux native builders

Docker recipes for the GitHub Actions runners that pack Baycat Linux natives
into this public `mhome-ai/releases` bucket.

| Directory | Name | Labels | Host |
|---|---|---|---|
| `linux-arm64/` | `meow-linux-arm64-runner` | `Linux,ARM64,release-linux-arm64` | Native ARM64 Docker (Apple Silicon or ARM Linux) |
| `linux-amd64/` | `meow-linux-amd64-runner` | `Linux,AMD64,release-linux-amd64` | amd64 Docker. On Apple Silicon this is Rosetta userspace, not QEMU |

Both can stay up on the same Apple Silicon Docker host. They use different
compose projects, labels, and named volumes. Each container mounts the host
Docker socket and a persistent `~/.ssh` volume for GitHub SSH keys.

Put a read key for `baycat`, `meowcore-rust`, and `releases` at
`id_ed25519` in that volume **before** the first start:

```bash
./seed-runner-ssh.sh meow-linux-arm64-runner_runner-ssh
./seed-runner-ssh.sh meow-linux-amd64-runner_runner-ssh
```

The entrypoint clones those three into the persistent `~/.mhome` volume if
they are missing. Image build does not clone: the key is not in the build.
Workflows never clone; they only `git fetch` tags into worktrees.

This is only source. `docker compose` identity is the `name:` in each
`compose.yaml`. Already-running containers and their volumes stay put when
these files change. Rebuild with `./compose.sh up -d --build` after recipe
edits. On a new machine, clone this repo and start a new pair of containers
there; do not share `.env` or volumes across machines.

`.env` is gitignored and only contains `RUNNER_TOKEN`. Org URL, runner name,
and labels are hardcoded. The token is only needed the first time a Docker
volume has no `.runner` file. These names are org-wide; a second host of the
same arch would replace the existing runner of that name.
