# MeowCore runtime assets

Public, versioned binary assets downloaded by MeowCore.

G2P releases are built and tested from the private source repository. This repository stores only the native binaries and their checksums, SBOMs, source-input receipts, build metadata, and license notices. It does not build from embedded source archives or publish Python/eSpeak bundles.

Kokoro acoustic models and voice packs are published as separate, independently
downloadable English and Chinese releases. Each release mirrors bytes pinned by
SHA-256 from the upstream ONNX exporter and includes Apache-2.0 model terms,
MIT exporter attribution, a source receipt, notices, and checksums. The private release repository
contains native G2P source and build logic. Model mirroring is intentionally
performed here with this repository's short-lived Actions token, so it needs no
cross-repository personal access token.

## Ollama Linux runtimes

Linux Ollama CPU/CUDA archives and the official macOS archive are packed here
from the GitHub release pinned in `ollama/runtimes.lock.json`. Pack, bump, and
verify run as npm scripts (`ollama:pack`, `ollama:bump`, `ollama:test`) in Node.
The published tarballs, MIT license, notices, and SHA-256 list go on the
immutable GitHub Release `ollama-v<engineVersion>`. Git does not store the
multi-gigabyte archives.

CPU packs drop `lib/ollama/cuda_v12` and `cuda_v13`. CUDA packs are the official
archives, renamed, and keep both CUDA 12 and 13 so Ollama can choose at runtime.
The macOS pack is the official `ollama-darwin.tgz`, mirrored unchanged. ROCm
extras are not published. ARM CUDA is the SBSA/server build, not Jetson.

The lockfile is the version pin. Official Ollama `v0.32.14` becomes our
Release `ollama-v0.32.14`. A new upstream version needs a new lock commit and a
new Release; tags are never overwritten.

Point the lock at a new official version (checksums come from the official
GitHub `sha256sum.txt`):

```bash
npm run ollama:bump -- 0.33.0
```

Official archives are downloaded by the packer into `ollama/upstream/` (gitignored).
If a file is already there and matches the pinned SHA-256, it is reused.

Validate without downloading the multi-gigabyte archives:

```bash
npm run ollama:test
```

Optional local pack after bump. CI is what publishes; this is a smoke check.
Cached official tarballs stay in `ollama/upstream/`.

```bash
npm run ollama:pack -- dist
```

Commit the lock, merge to `main`, then run workflow `Release Ollama Linux
runtimes`. That job reads the lock, fills `ollama/upstream/` as needed, packs
CPU/CUDA/darwin, and uploads GitHub Release `ollama-v<engineVersion>`. After it
finishes, copy `SHA256SUMS` into the desktop runtime catalog.

## Camera ReID OSNet

Camera person-reidentification ONNX weights. Version is three-part
(`1.0.0` → Release `camera-reid-osnet-v1.0.0`). The Camera node pins that tag
in its bundled manifest; it does not chase latest.

```bash
scripts/verify-camera-reid.sh
scripts/publish-camera-reid.sh false   # pack only
```

Commit `camera-reid.lock.json`, merge to `main`, then run workflow
`Release Camera ReID OSNet`. Tags are never overwritten.


## G2P

From the private `mhome-ai/tts` repository, dispatch `release-g2p.yml` on
`main` with an annotated `g2p-v<version>` source tag. After all jobs succeed,
use a GitHub CLI session with read access to TTS and release access here:

```sh
runtime-assets/scripts/publish-g2p.sh <tts-run-id> g2p-v<version>
```

The workflow builds all four macOS/Linux targets with the pinned toolchain.
The script verifies the downloaded payload against the source tag and checksums,
then checks the uploaded draft's digests before making the release public.
