# Linux ARM64 self-hosted runner

Docker template for a long-lived GitHub Actions runner that builds Baycat
Linux ARM64 natives. Matches GitHub-hosted `ubuntu-24.04-arm`.

Requires a native ARM64 Docker host (Apple Silicon or ARM Linux). Do not use
this compose file on x64; that path is QEMU and is not a release builder.
The amd64 sibling is `../linux-amd64/`; both compose projects can stay up on
the same Apple Silicon Docker host.

This recipe registers an organization runner at `https://github.com/mhome-ai`
named `meow-linux-arm64-runner` with labels `Linux,ARM64,release-linux-arm64`.
Those values are fixed in `entrypoint.sh`.

## Setup

Copy `.env.example` to `.env` in this directory (gitignored) and set
`RUNNER_TOKEN`.

Get the token from the **org** runner page (needs org admin):
https://github.com/organizations/mhome-ai/settings/actions/runners/new

Choose Linux / ARM64, then copy `--token`. When asked which repositories can
use the runner, pick **All repositories**. Tokens expire in about an hour and
are only needed the first time the Docker volume has no `.runner` file.

Private repos need a GitHub plan that allows org-level self-hosted runners
(typically Team or Enterprise). If registration returns 404 or jobs never
arrive, check that permission.

Rust, the Actions runner payload, Cargo caches, verified download cache, and
job workdirs live in Docker named volumes, not in this directory.
`docker compose down` keeps those volumes; `down -v` wipes them.

Packaging downloads (Ollama, camera models, ffmpeg, ONNX Runtime) use
`/home/runner/.cache/mhome-downloads`. The first Linux native job still
fetches each SHA once; later jobs restore from this volume instead of
Hugging Face or GitHub Releases. Clearing `~/.mhome/work/` does not delete
this cache.

## Commands

```bash
cd runners/linux-arm64
cp .env.example .env   # first time only; set RUNNER_TOKEN
./compose.sh up -d --build
./compose.sh logs -f
./compose.sh stop
./compose.sh start
```

Native Linux ARM64 runtime builds use this machine via
`mhome-ai/releases` `.github/workflows/native-linux-arm64.yaml`:

```yaml
runs-on: [self-hosted, Linux, ARM64, release-linux-arm64]
```

Tag `nlrX.Y.Z` on `mhome-ai/releases` builds and promotes only this
architecture. `linux-amd64` uses `nlx` and `release-linux-amd64`. Linux native,
Docker, and install jobs share the `linux-docker-host` concurrency group so they
do not compile on this Docker host at the same time.
