# releases

Public release artifacts for mHome products live on GitHub Releases in this
repository. This git tree is the release orchestrator only.

## How a release is cut

1. Attempt tags are `rYYYYMMDD-NN` in UTC, for example `r20261001-01`.
   Push that annotated tag on Baycat when this attempt publishes native or desktop,
   or on Plugin when it publishes plugins. The tag points at one commit already
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
`am`/`aw`. Mac native ARM (`nmr`) and Intel (`nmx`) share
the Mac Mini and the `native-runtime-stable-macos` lock, so they queue. `am` and `aw` stay separate platform tags and share the
`desktop-release` concurrency group. After a Linux Native release is public, the same workflow pushes that Host package to Docker Hub `mhomeai/meow-host` using the Native version. `latest` is published when both architectures of that version exist. This repo does not publish to GHCR. `deploy-meow-compose.yaml` publishes Baycat `docker/meow-compose.yml` to `https://install.mhome.ai/docker/stable/meow-compose.yml` on the same bucket.

Signing keys are repository or org Secrets. `APPLE_TEAM_ID` and the
publisher role ARNs are org Variables, visible to this public repo. Bucket
name and `https://install.mhome.ai` stay in `scripts/ci/lib.sh`. Workflows
do not use GitHub Environments.

Workflows never `git clone` and never `actions/checkout` product sources.
Runners must already have `~/.mhome/{baycat,meowcore-rust,pallas-cat,releases,harness}`
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

`scripts/ci/source-worktree.cjs` is used by Foundation, Agent, Agent cloud and MeowCore CI. Runners pre-provision each repository under `~/.mhome/` with their existing GitHub read access. The helper fetches the event commit, creates a detached worktree under a unique `~/.mhome/work/<repo>-<run>-<job>-<attempt>/`, and prepares the exact Agent pin for consumers. It never clones or changes canonical checkout branches, refuses existing work directories, and rolls back partial preparation. Cleanup removes only recorded task-owned worktrees. Workflows load the helper from the Releases main commit they just fetched; deliver this helper before dependent workflow updates.

## Plugin 独立发布

`plugin` 从 `~/.mhome/plugin` 的 annotated `tYYYYMMDD-NN` 取源码，使用 `pnmr/pnmx/pnlr/pnlx` 发布 Native 包。这个 `t` 由 Plugin 的 `r` 检查通过后创建。平台 Native 继续从 Baycat 构建。Plugin workflow 不编译 Baycat 或 MeowCore 源码。

首次运行需要准备官方 plugin 仓库、runner 只读凭据、`PLUGIN_PUBLISH_ROLE_ARN` 和 `PLUGIN_CATALOG_PRIVATE_KEY_B64`；Plugin 使用独立签名密钥，公钥已同步安装器，secret 和 S3 写权限独立。Plugin role 只写 `plugins/*/releases/*` 与 `plugins/stable/*`。版本清单地址为 `https://install.mhome.ai/plugins/<id>/releases/<version>/<platform>/manifest.bundle.json`，每个 Plugin 的版本独立保留。先上传不可变版本清单，再推广 `https://install.mhome.ai/plugins/stable/<platform>/catalog.bundle.json` 最新索引；不归档 S3 聚合历史 catalog。同版本重试复用原始签名文件，不覆盖旧版内容。先发布平台 Native，再发布 Plugin Native。Linux Node 装进 Baycat 的统一 Host 容器，不再单独发布家电镜像。

首次目录初始化须用对应 workflow 手动输入 tag 和 `initialize_catalog=true`。完整规则见 plugin 仓库 `release/README.md`。Catalog 保留插件源码与编排 commit；重试复用已经上传的完整签名快照。stable 的 `catalog.bundle.json` 最后原子写入，消费者不会读取中途更新的 JSON/签名对。同一 Linux 构建机或 Mac 签名环境仍使用公共资源锁。

Plugin 使用 `run-tagged-plugin.yaml` 的单个作业，复用平台已有的自托管 runner：macOS 在 alimao 的 `release-macos-primary`，Linux 在现有 `release-linux-arm64` / `release-linux-amd64`。同一 runner 先运行质量检查并构建，再核对本地产物的源码、编排 commit、tag 和摘要，最后签名上传。不经过 GitHub artifact 中转，也不要求额外机器。构建步骤不注入签名 secret；同机运行属于可信源码发布流程，不宣称凭据或物理隔离。

Plugin 源码必须来自 `origin/main` 上的 annotated `t` tag。没有 `t` 时不回退到 `r`。审核规则由维护者在 GitHub 配置，发布脚本不读取分支保护或历史 CI 状态，不需要跨仓库 API Token；当前冻结源码仍须通过本次构建的 `quality-gate.sh`。源码读取沿用现有 Git SSH 权限。Plugin CI 也使用现有自托管 runner，从预置仓库创建独立 worktree，只自动运行 main 提交；不在发布机上自动运行未经审核的第三方 PR。

## Desktop platform update feeds

Desktop app versions are independent across platforms. GitHub platform Releases
retain immutable packages, signatures and `latest.json`; new releases never
select GitHub global Latest. After public manifest and updater-package downloads
have been checked against the build output and the manifest signature has been
verified against the client's configured updater public key, `scripts/ci/publish-desktop-update.sh`
promotes only the current release's feeds to
`https://install.mhome.ai/desktop/stable/<OS-arch>/latest.json`.
Mac `am` updates `darwin-aarch64` and `darwin-x86_64`; Windows `aw` updates
`windows-x86_64`. Existing tags, source snapshots and the `desktop-release` queue
stay in place. There is no cross-platform manifest merge or transaction.

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

## Card DevKit distribution

`card-devkit.yaml` independently publishes the tools behind `meow customize card`.
It consumes an exact `card-devkit-vX.Y.Z` tag and full commit from Pallas, plus an
already published Meow CLI version on all five supported platforms. DevKit and App
versions are independent. The workflow validates the frozen DevKit directly; it
does not search historical App workflow logs. It never deploys the App website.

The public root is `https://install.mhome.ai/card-devkit/`, in
`mhome-install-distribution`, separate from the App website bucket. Each version
has one portable, preinstalled JavaScript DevKit, five normalized Node/npm archives,
public metadata/types/docs and a signed `devkit.json`. The manifest fixes the
source/orchestrator commits, worker protocol, minimum CLI version, OS requirements,
and every artifact URL, size and SHA-256. `acceptance.json` freezes the exact signed
native Client artifacts used for acceptance. The dependency inventory and package
license files travel with the release.

`card-devkit-runtime.json` pins official Node/npm versions and upstream checksums.
The publisher verifies Node's signed SHASUMS using the runner's pinned official
release keyring, then checks each archive against the committed checksum before
repacking. Dependency installation uses the committed npm lock with optional native
dependencies, install scripts and bin links disabled. Archive generation rejects
native addons and external links. The private Node/npm and compiler installation
requires no npm registry access on the consumer machine.

The workflow has three phases:

1. Freeze source and publisher, test the standalone package, prepare/sign, and
   upload immutable candidate files without changing the public version index.
2. On each supported platform, download the frozen released Meow CLI and exercise
   `toolchain install`, `init`, `deps install`, metadata, build, verify, preview
   hot reload, stop and uninstall in an isolated workdir with an empty system PATH.
   The macOS x64 job uses the existing Apple Silicon runner with Rosetta; the
   selected CLI and managed Node must actually report x64.
3. After every platform passes, recheck the source tag and all publicly served
   bytes, then conditionally update the single signed `index.json` using its ETag.

A failed candidate never enters the index. Exact-version installation intentionally
works before index promotion so the actual public installer can be tested. Candidate
URLs remain immutable: identical retries reuse the original signed bytes; changed
source, publisher, CLI inventory or artifacts require a new DevKit version. There
is no overwrite, compatibility alias, platform-specific index or automatic upgrade.

The signed JSON envelope stores exact payload bytes and their Minisign signature in
one object. It uses the existing official Runtime distribution trust key, also pinned
by the Meow CLI. Do not introduce an unsigned installer flag or an environment-based
public-key override. Local unit fixtures use a separate test-only public key.

Runner/publication prerequisites:

- Existing `~/.mhome/releases` and `~/.mhome/pallas-cat` repositories; workflows fetch
  exact objects into owned worktrees and never clone source repositories.
- Existing macOS ARM64 + Rosetta, Linux ARM64/x64 and Windows x64 self-hosted runners.
  All acceptance runners need Node to run the test recipe, Minisign and tar;
  consumer subprocesses receive an empty PATH and use only downloaded tools.
- Publisher: Node, npm, Python 3, Git, curl, AWS CLI, Minisign and `gpgv`.
  `NODE_RELEASE_KEYRING` is the repository/org variable naming a maintained local
  keyring of trusted official Node release keys. No keys are fetched implicitly.
- `RUNTIME_CATALOG_PRIVATE_KEY_B64` is the existing official Runtime signing key.
  `CARD_DEVKIT_PUBLISH_ROLE_ARN` grants OIDC PutObject/GetObject for `card-devkit/*`
  and ListBucket for existence checks. Secrets never enter release files.
- Public missing files must return 404; 403/auth/network errors are not treated as
  an empty distribution. Public JSON/text/tar downloads need correct MIME and CORS.
  Immutable version files use long-lived caching; the index uses `no-cache`.
- Publish the new Meow CLI first, then dispatch this workflow. Meow source checks
  and App release checks do not depend on this DevKit having been published.

Source-level tests:

```sh
node --test scripts/ci/card-devkit.test.cjs scripts/ci/workflow-contract.test.js
```

This workflow is independent of native product `r` → `t` tag coordination. DevKit
source uses its own explicit immutable tag; the workflow's fixed GitHub SHA identifies
its publisher. Do not turn an App deployment into the DevKit publication trigger.
