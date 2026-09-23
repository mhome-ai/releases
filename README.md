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

Agent is also a source input. Provision `~/.mhome/agent-rust` from the private `mhome-ai/agent` repository. After checking out MeowCore, source preparation reads its `release/sources/agent.json`, fetches that exact full commit and creates an adjacent `agent-rust` worktree. It does not use the canonical checkout's current HEAD. Cleanup includes the Agent worktree. The Agent commit must be available on origin before releasing the consumer tag; these scripts do not publish it.

## Shared CI source bootstrap

`scripts/ci/source-worktree.cjs` is used by Foundation, Agent, Agent cloud and MeowCore CI. Runners pre-provision each repository under `~/.mhome/` with their existing GitHub read access. The helper fetches the event commit, creates a detached worktree under a unique `~/.mhome/work/<repo>-<run>-<job>-<attempt>/`, and prepares the exact Agent pin for consumers. It never clones or changes canonical checkout branches, refuses existing work directories, and rolls back partial preparation. Cleanup removes only recorded task-owned worktrees. Workflows load the helper from the Releases main commit they just fetched; deliver this helper before dependent workflow updates.
