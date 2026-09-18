# releases

Public release artifacts for mHome products live on GitHub Releases in this
repository. This git tree is also the release orchestrator: GitHub Actions
workflows here publish Desktop, Native, and Docker from pinned product source
tags.

## How a release is cut

1. Pin product sources with annotated tags `vX.Y.Z` on baycat (and pallas for
   Desktop). MeowCore stays on its own `v*` tag, recorded in baycat
   `release/sources/dependencies.json`.
2. Push a product tag on **this** repo: `am1.2.3`, `nlr1.2.3`, `nlx1.2.3`,
   `d1.2.3`, and so on.
3. Self-hosted runners fetch those source tags into sibling worktrees under
   `~/.mhome/work/<run>/`. Canonical checkouts stay on their default branches
   at `~/.mhome/<repo>` for Harness E2E.

Workflows do not `actions/checkout` product repos. Pack scripts stay in the
product trees. YAML here only decides which runner runs which script.

## Runners

Linux native builds use the Docker recipes in `runners/`. Each container has a
persistent `~/.mhome` volume. Clone this repo on a host, put `RUNNER_TOKEN` in
`.env`, and start compose. Org URL, runner name, and labels are fixed.
Composing an edit does not recreate already-running containers.
