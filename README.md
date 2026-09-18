# releases

Public release artifacts for mHome products live on GitHub Releases in this
repository. This git tree is the operator recipe for that public bucket, not
the binaries themselves.

Linux native builds run on long-lived self-hosted GitHub Actions runners.
Those Docker recipes are in `runners/`. Clone this repo on any machine that
should host a builder, put `RUNNER_TOKEN` in `.env`, and start compose.
Org URL, runner name, and labels are fixed in the recipe. Compose project
names are stable, so editing this source does not recreate containers that
are already running on a host.
