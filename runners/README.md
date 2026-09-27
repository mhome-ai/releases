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

## Debian 11 compatibility

Both builder images use Debian 11 / glibc 2.31 because OEM devices still need
that baseline. This is the build environment inside Docker; the Mac host's OS
does not determine the Linux binary's glibc requirement. Product dependencies
and packaged third-party binaries still need their own compatibility checks.

The Debian base is pinned by its multiarchitecture digest. Both recipes use
the shared `debian11.sources`, frozen to the 2026-09-03 snapshot. After
Bullseye LTS ended, the live security index referenced removed `.deb` files,
causing image provisioning to fail before product compilation
([Debian bug 1147093](https://bugs.debian.org/1147093)). Using this snapshot
keeps the original compiler and libc baseline with retrievable packages.

Only the historical Release file's freshness check is disabled. APT still
verifies Debian archive signatures and package hashes; HTTP is used to
bootstrap `ca-certificates`. The snapshot does not receive new security fixes.
Updating the builder is an explicit change to the pinned source and image,
followed by builds for both architectures; it does not require updating OEM
devices to a newer Debian release.

Every image build runs `verify-linux-builder.sh` as the runner user. It checks
Debian 11 / glibc 2.31, compiles and executes C/C++ samples, and loads the
release CLIs and native build dependencies. To repeat it without registering
an Actions runner or attaching credentials:

```bash
docker run --rm --platform linux/arm64 --entrypoint verify-linux-builder.sh meow-linux-arm64-runner:local
docker run --rm --platform linux/amd64 --entrypoint verify-linux-builder.sh meow-linux-amd64-runner:local
```

An edited Dockerfile does not update an existing runner. Rebuild and replace
each idle container with its existing compose project and named volumes;
registration, source checkouts and caches remain in those volumes. Do not use
`down -v`. Cargo objects for this baseline live under `cargo-target/debian11`,
separately from old Ubuntu objects.

Put a read key for `baycat`, `plugin`, `meowcore-rust`, `agent`, `agent-cloud`,
`foundation`, and `releases` at
`id_ed25519` in that volume **before** the first start:

```bash
./seed-runner-ssh.sh meow-linux-arm64-runner_runner-ssh
./seed-runner-ssh.sh meow-linux-amd64-runner_runner-ssh
```

The entrypoint clones those repositories into the persistent `~/.mhome` volume if
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
