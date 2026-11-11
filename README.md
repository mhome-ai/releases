# releases

Public release artifacts for mHome products live on GitHub Releases in this
repository. This git tree is the release orchestrator only.

## How a release is cut

1. Attempt tags are `rYYYYMMDD-NN` in UTC, for example `r20261001-01`.
   Push that annotated tag on Baycat when this attempt publishes native or desktop,
   or on Integration when it publishes plugins. The tag points at one commit already
   on the default branch. CI checks that commit. After the checks pass, CI creates
   annotated `t20261001-01` at the same commit. A failed, cancelled, or unfinished
   attempt keeps `r` and does not create `t`. Tags are not moved: rerun the same
   `r` after an environment failure, and use a new number after a source change.
   If `t` already points at the checked commit, creating it again is a no-op; a
   different commit is an error. Desktop checks out the Pallas `vX.Y.Z` named in
   Baycat `release/sources/dependencies.json`.
   `node scripts/ci/next-attempt-tag.js --repo mhome-ai/baycat` prints the next
   `r` tag, counting existing `r` and `t` numbers. Real versions stay in source.
   MeowCore, Agent, and Pallas keep `vX.Y.Z`.
2. Push one platform tag on **this** repo, using that same attempt as the
   suffix: `nmr20261001-01`, `am20261001-01`, `pnmr20261001-01`. The workflow checks out `t20261001-01` from the source
   repo that owns the channel. Without that `t` tag it stops. It does not fall
   back to `r` or to the default branch. A component or app whose version did not
   advance is left as-is.
3. The matching workflow file (one tag prefix, one job, one runner) runs
   `scripts/ci/run.sh` from a worktree of this repo. That script fetches the
   product source tags into sibling worktrees under `~/.mhome/work/<id>/` and
   runs the pack scripts in the product tree. Canonical checkouts at
   `~/.mhome/<repo>` stay on their default branches for Harness.

One workflow run is one machine. Native `nlr`/`nlx`/`nmr`/`nmx`/`nw`, Desktop
`am`/`aw`/`alr`/`alx`. Mac native ARM (`nmr`) and Intel (`nmx`) share
the Mac Mini and the `native-runtime-stable-macos` lock, so they queue. `am` and `aw` stay separate platform tags and share the
`desktop-release` concurrency group. Linux desktop ARM64 (`alr`) and x64 (`alx`) use their existing Linux runners and the `linux-docker-host` queue. Each publishes an AppImage, its updater signature and a Debian installer. They build inside the pinned Debian 12/WebKitGTK 4.1 desktop image, leaving Native's Debian 11 compatibility baseline unchanged. After a Linux Native release is public, the same workflow pushes that Host package to Docker Hub `mhomeai/meow-host` using the Native version. `latest` is published when both architectures of that version exist. This repo does not publish to GHCR. `deploy-meow-compose.yaml` publishes Baycat `docker/meow-compose.yml` to `https://install.mhome.ai/docker/stable/meow-compose.yml` on the same bucket.

Signing keys are repository or org Secrets. `APPLE_TEAM_ID` and the
publisher role ARNs are org Variables, visible to this public repo. Bucket
name and `https://install.mhome.ai` stay in `scripts/ci/lib.sh`. Workflows
do not use GitHub Environments.

Workflows never `git clone` and never `actions/checkout` product sources.
Runners must already have `~/.mhome/{baycat,integration,meowcore-rust,pallas-cat,releases,harness}`
and SSH that can fetch GitHub. Pack scripts stay in the product trees.

## Runners

Linux native builds use the recipes in `runners/`. Each container
has a persistent `~/.mhome` volume, a deploy-key volume at `~/.ssh`, and the
host Docker socket. Put a GitHub SSH read key in the `runner-ssh` volume
before the first start. The entrypoint clones `baycat`, `meowcore-rust`, and
`releases` into `~/.mhome` if they are missing. Org URL, runner name, and
labels are fixed.

Composing an edit does not recreate already-running containers. Rebuild with
`./compose.sh up -d --build` after changing these recipes.

Agent is also a source input. Provision `~/.mhome/agent` from the private `mhome-ai/agent` repository. After checking out MeowCore, source preparation reads its `release/sources/agent.json`, fetches that exact full commit and creates an adjacent `agent` worktree. It does not use the canonical checkout's current HEAD. Cleanup includes the Agent worktree. The Agent commit must be available on origin before releasing the consumer tag; these scripts do not publish it.

## Shared CI source bootstrap

`scripts/ci/source-worktree.cjs` is used by Foundation, Agent, Tiger and MeowCore CI. Runners pre-provision each repository under `~/.mhome/` with their existing GitHub read access. The helper fetches the event commit, creates a detached worktree under a unique `~/.mhome/work/<repo>-<run>-<job>-<attempt>/`, and prepares the exact Agent pin for consumers. It never clones or changes canonical checkout branches, refuses existing work directories, and rolls back partial preparation. Cleanup removes only recorded task-owned worktrees. Workflows load the helper from the Releases main commit they just fetched; deliver this helper before dependent workflow updates.

## Matter ESP32-C5 firmware

`matter-esp32c5.yaml` publishes the 32 MB flash / 8 MB PSRAM `psram_ble` board
profile. The firmware repository owns source checks: annotated `rYYYYMMDD-NN`
on `meow-matter-esp/main` produces annotated `tYYYYMMDD-NN` only after manifest
tests, host sanitizer tests and a complete test-signed firmware build pass.
The product version lives in that source's `version.txt`, not in the date tag.

Create annotated `mec5YYYYMMDD-NN` on this repository's `main` to release the
matching `t`. Manual dispatch accepts that existing release tag and uses its
orchestrator commit too. The workflow refuses absent/lightweight/moved tags and
source outside `origin/main`; it never falls back to `r` or the latest source.
Source and orchestrator use sibling worktrees under `~/.mhome/work/<run>/`.
The original push/dispatch event selects the tag. A run-owned
`matter-invocation.json` records that identity; phase commands take the run directory
as an argument, and firmware compilation takes `--bundle <signed-manifest>`.

The existing `release-macos-primary` runner requires pre-provisioned
`~/.mhome/{releases,meow-matter-esp}`, read access to both repositories, Node 20+,
Python 3, GitHub CLI, minisign and ESP-IDF 5.5.5 installed at
`$HOME/esp/esp-idf-v5.5.5`. Source-check jobs also need Homebrew mbedTLS. Configure
the existing `PLUGIN_CATALOG_PRIVATE_KEY_B64` Secret for this repository; its key
must match the publisher public key already trusted by the firmware and MeowCore.
No key rotation is part of this workflow. Signing gets the private key in a
temporary file, removes it before compilation, and build receives neither the
signing Secret nor GitHub write credentials. These steps share the existing
trusted self-hosted runner, not a physical security boundary.

The release generates the signed Node declaration **before** compiling and
embeds it in the application. Its archive contains the application, bootloader,
partition table, initial OTA data, flash offsets, signed declaration and a
`release.json` record with source/orchestrator identities and file SHA-256 hashes.
Packaging checks the actual application descriptor, embedded declaration, SDK
version, board layout and production Cloud identity endpoint. Test compilation
uses the same `psram_ble` production endpoint; its disposable signer still cannot
join production Core. The embedded signature authenticates the declaration;
it is not an ESP Secure Boot signature over the complete firmware image.

A draft becomes public only after its downloaded archive passes verification.
Existing complete archives are downloaded and verified before reusing their
original bytes; retries do not rebuild or overwrite public firmware. A firmware
version already used by another attempt requires a new `version.txt`. An incomplete
GitHub asset upload fails with an explicit diagnostic for draft inspection rather
than overwriting ambiguous data. Firmware releases use `--latest=false` and do
not affect desktop update feeds. The workflow does not flash devices, erase NVS,
configure OTA delivery or claim hardware acceptance.

Offline checks for this orchestration:

```sh
node --test scripts/ci/matter-release.test.js scripts/ci/workflow-contract.test.js
```

## Plugin 独立发布

`plugin` 从 `~/.mhome/integration` 的 annotated `tYYYYMMDD-NN` 取源码，使用 `pnmr/pnmx/pnlr/pnlx` 发布 Native 包。这个 `t` 由 Integration 的 Plugin 源码 `r` 检查通过后创建。平台 Native 继续从 Baycat 构建。Plugin workflow 不编译 Baycat 或 MeowCore 源码。

首次运行需要准备官方 integration 仓库、runner 只读凭据、`PLUGIN_PUBLISH_ROLE_ARN` 和 `PLUGIN_CATALOG_PRIVATE_KEY_B64`；Plugin 使用独立签名密钥，公钥已同步安装器，secret 和 S3 写权限独立。Plugin role 只写 `plugins/*/releases/*` 与 `plugins/stable/*`。版本清单地址为 `https://install.mhome.ai/plugins/<id>/releases/<version>/<platform>/manifest.bundle.json`，每个 Plugin 的版本独立保留。先上传不可变版本清单，再推广 `https://install.mhome.ai/plugins/stable/<platform>/catalog.bundle.json` 最新索引；不归档 S3 聚合历史 catalog。同版本重试复用原始签名文件，不覆盖旧版内容。先发布平台 Native，再发布 Plugin Native。Linux Node 装进 Baycat 的统一 Host 容器，不再单独发布家电镜像。

首次目录初始化须用对应 workflow 手动输入 tag 和 `initialize_catalog=true`。完整规则见 integration 仓库 `release/README.md`。Catalog 保留插件源码与编排 commit；重试复用已经上传的完整签名快照。stable 的 `catalog.bundle.json` 最后原子写入，消费者不会读取中途更新的 JSON/签名对。同一 Linux 构建机或 Mac 签名环境仍使用公共资源锁。

Plugin 使用 `run-tagged-plugin.yaml` 的单个作业，复用平台已有的自托管 runner：macOS 在 alimao 的 `release-macos-primary`，Linux 在现有 `release-linux-arm64` / `release-linux-amd64`。同一 runner 先运行质量检查并构建，再核对本地产物的源码、编排 commit、tag 和摘要，最后签名上传。不经过 GitHub artifact 中转，也不要求额外机器。构建步骤不注入签名 secret；同机运行属于可信源码发布流程，不宣称凭据或物理隔离。

Plugin 源码必须来自 `origin/main` 上的 annotated `t` tag。没有 `t` 时不回退到 `r`。审核规则由维护者在 GitHub 配置，发布脚本不读取分支保护或历史 CI 状态，不需要跨仓库 API Token；当前冻结源码仍须通过本次构建的 `quality-gate.sh`。源码读取沿用现有 Git SSH 权限。Plugin CI 也使用现有自托管 runner，从预置仓库创建独立 worktree，只自动运行 main 提交；不在发布机上自动运行未经审核的第三方 PR。

## Desktop platform update feeds

User-facing desktop notes may be frozen with the publishing orchestrator in
`release-notes/desktop/v<app-version>.md`, including the product/version heading.
The release copies that exact nonempty Markdown into its artifacts. When absent,
it uses the existing Baycat source-note formatter; missing notes still fail rather
than falling back to Git commit messages. Publication notes do not alter runtime
source tags, and their provenance is the selected Releases commit.

Desktop app versions are independent across platforms. GitHub platform Releases
retain immutable packages, signatures and `latest.json`; new releases never
select GitHub global Latest. After public manifest and updater-package downloads
have been checked against the build output and the manifest signature has been
verified against the client's configured updater public key, `scripts/ci/publish-desktop-update.sh`
promotes only the current release's feeds to
`https://install.mhome.ai/desktop/stable/<OS-arch>/latest.json`.
Mac `am` updates `darwin-aarch64` and `darwin-x86_64`; Windows `aw` updates
`windows-x86_64`. Linux `alr` updates `linux-aarch64-appimage` and
`linux-aarch64-deb`; `alx` updates `linux-x86_64-appimage` and `linux-x86_64-deb`.
Linux updater endpoints include Tauri's bundle type so a Debian installation never
downloads an AppImage update. Linux desktop image builds reuse the Docker daemon's
prepared BuildKit cache; native builds retain their separate disposable builders.
The x64 desktop recipe prepares a SHA-256-pinned AppImage output plugin with the
same ELF padding treatment Tauri applies to linuxdeploy, allowing execution on
the Docker x64 emulation host. The distributed installers retain their original
headers and signatures. Container acceptance records any temporary extraction
adapter and does not claim physical desktop acceptance.
Existing source snapshots and platform queues stay in place. There is no
cross-platform manifest merge or transaction.

A feed cannot move to a lower app version or change package/metadata at the same
version. Exact retries leave the object unchanged and verify the public address.
A public-release retry downloads the original signed artifacts and verifies the
frozen app version and source revision before skipping the build. A failure before
promotion leaves stable untouched; a failure after a successful PUT is reported
for confirmation/retry, without automatically reverting it.

Deployment prerequisites (configure before releasing new clients):

- Set org Variable `DESKTOP_PUBLISH_ROLE_ARN`, visible to this repo. An existing
  distribution role may be used if its OIDC trust and object permissions cover
  desktop publication; this change does not create or modify an AWS role.
- Install AWS CLI on both desktop runners. Grant `s3:ListBucket` on the existing
  distribution bucket so a missing object's HEAD returns 404, and `s3:GetObject`
  / `s3:PutObject` on `desktop/stable/*`.
- Make that CDN path publicly readable with Minimum TTL 0 and origin cache headers
  respected. Stable JSON is uploaded with
  `no-cache,no-store,max-age=0,must-revalidate`.
- Freeze a Baycat `t` containing the new client endpoint and manifest helper;
  create the platform tag on a Releases commit containing the new orchestrator.
  Old tagged source/orchestrator snapshots do not gain the new behavior on rerun.
- Existing clients using global Latest need a separate migration if already
  distributed. New clients never fall back to the shared endpoint.

Offline rollout regression tests use an adjacent current Baycat checkout:

```bash
node --test scripts/ci/desktop-release.test.js scripts/ci/publish-desktop-update.test.js
# For a development worktree, set DESKTOP_TEST_BAYCAT to that Baycat checkout.
```

## Developer Kit distribution

`developer-kit.yaml` publishes UI, Extension and experimental Wave tooling behind
`meow make`. Source logic stays in Pallas, Integration and Wave respectively;
Releases freezes, signs, verifies and distributes it. A release selects an exact
`kit-<ui|extension|wave>-vX.Y.Z` source tag/full commit and an already published
meow CLI version on all four supported Mac/Linux platforms (ARM64 and x64).
Windows is not advertised or included in this first release. No Kit release
deploys the App website or distributes the Wave firmware SDK.

The root is `https://install.mhome.ai/devkits/<kit>/`, in the existing
`mhome-install-distribution` bucket. Each immutable version contains signed
`kit.json`, exact preinstalled worker payloads and four normalized Node/npm
archives. UI/Wave share portable payloads; Extension carries each platform's locked
native esbuild dependency. The manifest binds Kit identity, source/publisher
commits, worker protocol, minimum CLI/OS, and URL/size/SHA-256 of every asset.
`acceptance.json` freezes signed, released native CLI artifacts for verification.

`developer-kit-runtime.json` pins official Node/npm versions and upstream hashes.
The publisher verifies Node's signed SHASUMS with the fixed official public key
under `scripts/ci/node-release-keys/`. Its source commit, fingerprint, hash and
third-party license are recorded alongside it. Package installation uses committed locks with lifecycle scripts and bin
links disabled. Every archive rejects links/special files and preserves required
executable bits. Consumers do not npm-install the Kit itself or need system Node.

The workflow first builds frozen source without publisher credentials, signs and
uploads immutable candidate files, and leaves the index unchanged. Each supported
platform then runs the real public installer with an empty system PATH. UI checks
both bases, type checking, build/verify, tamper rejection and explicit rebuilding.
Desktop Preview separately requires a signed-in installed App and active Space;
this offline release gate does not claim App/device acceptance. Extension checks
independent TS validation, ordinary dependency installation, actual behavior tests
and builds. Wave checks the installed generator/checker against a clearly labeled
recorded compiler fixture; it does not claim live Hub or device/SDK acceptance.
Only after every job succeeds does promotion recheck the source tag and public
bytes and conditionally update that Kit's signed index using its ETag.

Exact-version install works before promotion for acceptance. A failed candidate
never enters the index. Identical retries preserve original signed bytes; changed
source/publisher/artifacts require a new Kit version. Retained historical Card
artifacts are immutable; the active workflow and CLI use only the new distribution.
Node downloads are shared by content in the client cache across Kits.

The existing Runtime Minisign trust key remains authoritative. No unsigned
installer flag or environment-based public-key override is added. Workflow inputs,
work paths, source identities and selected CLI travel through explicit
arguments/private invocation JSON. Fixed verification keys are derived from source.
The only step-specific secret environment is
`RUNTIME_CATALOG_PRIVATE_KEY_B64`; standard GitHub/AWS tool credentials remain.

Runner/release prerequisites:

- Existing flat `~/.mhome/releases` and relevant source repositories with their
  origins, provisioned on the publisher; fetch exact objects into owned worktrees,
  never clone implicitly. Wave's source remote/release preparation is still a
  prerequisite; implementing its Kit does not create a repository or issue tags.
- Existing macOS ARM64 + Rosetta and Linux ARM64/x64 self-hosted
  runners, with Node for the recipe, Minisign and tar. Product subprocesses use
  only the downloaded managed tools.
- Publisher Node/npm, Python 3, Git, AWS CLI, Minisign and GnuPG (`gpg`/`gpgv`).
  No keyring GitHub variable or environment override is required.
- Reuse `RUNTIME_PUBLISH_ROLE_ARN` for credential setup. Deploy Baycat's
  `release/docker/aws-distribution.yml` update first: the Runtime role must trust
  this workflow and permit scoped `devkits/*` Get/Put/List operations. Source
  changes do not apply IAM policy updates. Secrets never enter artifacts or invocation files.
- Publish Script's required testing export and refresh Integration's root/Kit npm
  pins and locks before releasing Extension. Publish the new meow CLI first.
  Deploy new Hub/Lion contract support before live Wave contract acquisition.
- Authenticated S3 reads establish absence and preserve the original signed bytes
  on retries. Only S3's missing-object response permits a first publication;
  permission/network failures stop it. Public CDN reads verify uploaded bytes,
  never establish absence. Version files use immutable caching, indices use
  no-cache. MIME/CORS remain correct.

```sh
node --test scripts/ci/developer-kit.test.cjs scripts/ci/workflow-contract.test.js
```

## Plugin SDK distribution

`developer-sdk.yaml` publishes the ordinary Cargo SDK independently from Kit
distribution. Select Integration's exact `sdk-plugin-vX.Y.Z` tag and full commit;
the tag version is the public `mhome-plugin-sdk` facade version. The source owner
keeps its three crate versions independent. No SDK release is implied by a Kit
release or by source staging.

The macOS publisher uses its existing flat Integration, Foundation and Releases
checkouts. It freezes the SDK source and publisher, tests the normalized crates
without credentials, then checks an exact source inventory before publication.
Publication builds and tests with registry dependencies and no local path patches,
sharing compiled dependency output across the three packages. Order is service API,
runtime, public facade. Existing registry versions require archive equivalence;
uncertain writes get read-only resolution without another upload.
Registry-based builds, tests, packaging and verification also remove the Cargo
upload token from their child environment. Only the final `cargo publish
--no-verify` inherits it, after the same locked source has passed compilation and
tests; uploading does not rerun author build scripts with that credential.

Registry verification reuses Foundation's existing bounded verifier, frozen to the
already published tag/commit/hash in `developer-sdk-registry.json`; it does not
introduce a third fork of that tool. SDK Cargo metadata records the Integration
source tag and full commit. Apache-2.0 LICENSE/NOTICE files ship with every crate.
The publication step uses the existing standard `CARGO_REGISTRY_TOKEN` secret;
Releases must have access to that credential before invocation. This source change
does not configure secrets, create tags or upload crates. Source inspection cannot
prove that a missing GitHub secret is inherited from another repository.

```sh
node --test scripts/ci/developer-sdk.test.cjs scripts/ci/workflow-contract.test.js
```

The `developer-kit.yaml` dispatch entry calls `run-developer-kit.yaml` at the same
commit. AWS trust names that reusable workflow, so its `job_workflow_ref` claim is
present; direct dispatch jobs cannot satisfy that trust condition. All platform
jobs remain self-hosted.
