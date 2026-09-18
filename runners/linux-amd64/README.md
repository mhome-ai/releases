# Linux amd64 self-hosted runner

Docker template for a long-lived GitHub Actions runner that builds Baycat
Linux amd64 natives (`linux-amd64` / `x86_64-unknown-linux-gnu`). Matches
GitHub-hosted `ubuntu-24.04`.

The ARM sibling is `../linux-arm64/`. Both containers can stay up at once;
they use different compose projects, labels, and named volumes.

On Apple Silicon this is amd64 **userspace** via Docker Desktop Rosetta,
not a real amd64 kernel and not QEMU. Enable **Use Rosetta for x86_64/amd64
emulation on Apple Silicon**. Do not use this compose file without Rosetta.

This recipe registers an organization runner at `https://github.com/mhome-ai`
named `meow-linux-amd64-runner` with labels `Linux,AMD64,release-linux-amd64`.
Those values are fixed in `entrypoint.sh`. GitHub still names the runner
archive and Node tarball `linux-x64`; that is their filename, not our
platform id.

## Setup

Copy `.env.example` to `.env` in this directory (gitignored) and set
`RUNNER_TOKEN`.

Get the token from the **org** runner page (needs org admin):
https://github.com/organizations/mhome-ai/settings/actions/runners/new

Choose Linux / amd64, then copy `--token`. GitHub's runner form may still
label the architecture x64; that is their archive name, not ours. When asked
which repositories can use the runner, pick **All repositories**. Tokens expire
in about an hour and are only needed the first time the Docker volume has no
`.runner` file.

Private repos need a GitHub plan that allows org-level self-hosted runners
(typically Team or Enterprise). If registration returns 404 or jobs never
arrive, check that permission.

Rust, the Actions runner payload, Cargo caches, verified download cache, and
job workdirs live in Docker named volumes, not in this directory.
`docker compose down` keeps those volumes; `down -v` wipes them.

Packaging downloads (Ollama, camera models, ffmpeg, ONNX Runtime) use
`/home/runner/.cache/mhome-downloads`. The first Linux native job still
fetches each SHA once; later jobs restore from this volume instead of
Hugging Face or GitHub Releases. Isolated checkout cleanup does not delete
this cache.

## Commands

```bash
cd runners/linux-amd64
cp .env.example .env   # first time only; set RUNNER_TOKEN
./compose.sh up -d --build
./compose.sh logs -f
./compose.sh stop
./compose.sh start
```

Native Linux amd64 runtime builds use this machine via Baycat
`.github/workflows/native-runtime-platform-release.yaml`:

```yaml
runs-on: [self-hosted, Linux, AMD64, release-linux-amd64]
```

Linux native `workflow_dispatch` with `platform=linux-amd64` (tag `nlxX.Y.Z`)
builds, drafts, and promotes only this architecture. `linux-arm64` uses
`nlr` and `release-linux-arm64`. Both compile jobs share one host lock so they
do not run at the same time.
