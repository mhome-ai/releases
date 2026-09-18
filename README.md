# releases

Public release artifacts for mHome products live on GitHub Releases in this
repository. This git tree is the release orchestrator only.

## How a release is cut

1. Freeze product sources with annotated tags `vX.Y.Z` (`npm run freeze-source`
   in baycat; same tag on pallas for Desktop). MeowCore stays on its own `v*`
   tag, recorded in baycat `release/sources/dependencies.json`. This does not
   publish.
2. Later, push a product tag on **this** repo: `am1.2.3`, `nlr1.2.3`,
   `nlx1.2.3`, `dlr1.2.3`.
3. The matching workflow job picks a self-hosted runner and runs
   `scripts/ci/run.sh` from a worktree of this repo. That script fetches the
   product source tags into sibling worktrees under `~/.mhome/work/<id>/` and
   runs the pack scripts in the product tree. Canonical checkouts at
   `~/.mhome/<repo>` stay on their default branches for Harness.

One workflow run is one machine. Native `nlr`/`nlx`/`nm`/`nw`, Desktop
`am`/`aw`, Docker `dlr`/`dlx`. GitHub Latest for Desktop still lives on the
asset tag `aX.Y.Z`; `am` and `aw` both publish onto that tag. Docker Catalog
is written by whichever of `dlr`/`dlx` runs second for that version.

Workflows never `git clone` and never `actions/checkout` product sources.
Runners must already have `~/.mhome/{baycat,meowcore-rust,pallas-cat,releases,harness}`
and SSH that can fetch GitHub. Pack scripts stay in the product trees.

## Runners

Linux native and Docker builds use the recipes in `runners/`. Each container
has a persistent `~/.mhome` volume, a deploy-key volume at `~/.ssh`, and the
host Docker socket. Provision clones and the deploy key **on the runner**,
then start compose. Org URL, runner name, and labels are fixed.

```bash
# once per machine, inside the runner volume
git clone git@github.com:mhome-ai/baycat.git ~/.mhome/baycat
git clone git@github.com:mhome-ai/meowcore-rust.git ~/.mhome/meowcore-rust
git clone git@github.com:mhome-ai/releases.git ~/.mhome/releases
# Desktop also needs pallas-cat; E2E needs harness
```

Composing an edit does not recreate already-running containers.
