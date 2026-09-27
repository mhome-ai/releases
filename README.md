# releases

Public release artifacts for mHome products live on GitHub Releases in this
repository. This git tree is the release orchestrator only.

## How a release is cut

1. Freeze product sources with annotated tags `vX.Y.Z` (`npm run freeze-source`
   in baycat; same tag on pallas for Desktop). MeowCore stays on its own `v*`
   tag, recorded in baycat `release/sources/dependencies.json`. This does not
   publish.
2. Later, push a product tag on **this** repo: `am1.2.3`, `nlr1.2.3`,
   `nlx1.2.3`, `nmr1.2.3`, `nmx1.2.3`, `dlr1.2.3`.
3. The matching workflow file (one tag prefix, one job, one runner) runs
   `scripts/ci/run.sh` from a worktree of this repo. That script fetches the
   product source tags into sibling worktrees under `~/.mhome/work/<id>/` and
   runs the pack scripts in the product tree. Canonical checkouts at
   `~/.mhome/<repo>` stay on their default branches for Harness.

One workflow run is one machine. Native `nlr`/`nlx`/`nmr`/`nmx`/`nw`, Desktop
`am`/`aw`, Docker `dlr`/`dlx`. Mac native ARM (`nmr`) and Intel (`nmx`) share
the Mac Mini and the `native-runtime-stable-macos` lock, so they queue. GitHub Latest for Desktop still lives on the
asset tag `aX.Y.Z`; `am` and `aw` both publish onto that tag and share the
`desktop-release` concurrency group. Docker Catalog is per platform:
`docker/stable/linux-arm64/` and `docker/stable/linux-x64/`. `dlr` and `dlx`
do not wait for each other.

Signing keys are repository or org Secrets. `APPLE_TEAM_ID` and the three
publisher role ARNs are org Variables, visible to this public repo. Bucket
name and `https://install.mhome.ai` stay in `scripts/ci/lib.sh`. Workflows
do not use GitHub Environments.

Workflows never `git clone` and never `actions/checkout` product sources.
Runners must already have `~/.mhome/{baycat,meowcore-rust,pallas-cat,releases,harness}`
and SSH that can fetch GitHub. Pack scripts stay in the product trees.

## Runners

Linux native and Docker builds use the recipes in `runners/`. Each container
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

`plugin` 从 `~/.mhome/plugin` 的 annotated `vX.Y.Z` 取源码，使用 `pnmr/pnmx/pnlr/pnlx` 发布 Native 包，`pdlr/pdlx` 发布 Linux 家电镜像。平台 Native 和 Core Docker 继续从 Baycat 构建。Plugin workflow 不编译 Baycat 或 MeowCore 源码。

首次运行需要准备官方 plugin 仓库、PR 审核、runner 只读凭据、`PLUGIN_PUBLISH_ROLE_ARN` 和 `PLUGIN_CATALOG_PRIVATE_KEY_B64`；Plugin 使用独立签名密钥，公钥已同步安装器，secret 和 S3 写权限独立。Plugin role 只写 `plugins/*` 指定前缀。先发布平台 Native 1.0.5，再发布 Plugin Native，最后发布依赖固定 Host 包的家电镜像。

首次目录初始化须用对应 workflow 手动输入 tag 和 `initialize_catalog=true`。完整规则见 plugin 仓库 `release/README.md`。Catalog 保留插件源码与编排 commit；重试复用已经上传的完整签名快照。stable 的 `catalog.bundle.json` 最后原子写入，消费者不会读取中途更新的 JSON/签名对。同一 Linux 构建机或 Mac 签名环境仍使用公共资源锁。

Plugin 使用 `run-tagged-plugin.yaml` 的两个作业。一次性构建机带 `plugin-build-ephemeral` 标签，仅能读取源码；发布机下载同一 run 的产物，核对源码/编排 commit 和 tag 后验证、签名、上传。发布机不编译或执行插件。二者不能共用物理宿主、Docker daemon、工作盘或凭据；不同 runner 名只是额外防误配检查，不能代替部署隔离。

Plugin 源码必须是受保护 `origin/main` 上且通过两平台 Plugin quality 检查的 commit。`main` 开启 CODEOWNERS 审核、过期审核失效和管理员保护。私有仓库配置 `PLUGIN_SOURCE_READ_TOKEN`，仅授予 Plugin Contents/Checks/Administration 读取权限。源码 PR 校验使用 GitHub 托管 runner；发版构建使用专用一次性 runner。配置未就绪时流水线明确拒绝发布。
