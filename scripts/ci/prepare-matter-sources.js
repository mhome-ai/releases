"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { PRODUCT_REPOS, canonicalClonePath, releaseWorkRoot } = require("./mhome-root");
const { fetchTag, requireExistingClone } = require("./prepare-release-sources");
const git = (repo, ...args) => execFileSync("git", ["-C", repo, ...args], {
  encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
}).trim();

function assertSnapshot(repo, tag, revision, tagObject) {
  const refs = new Map(git(repo, "ls-remote", "--exit-code", "origin", `refs/tags/${tag}`, `refs/tags/${tag}^{}`)
    .split("\n").map(line => line.split(/\s+/)).map(([sha, ref]) => [ref, sha]));
  if (refs.get(`refs/tags/${tag}`) !== tagObject || refs.get(`refs/tags/${tag}^{}`) !== revision) {
    throw new Error(`Frozen tag ${tag} moved or is missing; refusing publication`);
  }
}

function prepareMatterSources({ tag, workId, home = os.homedir() }) {
  if (!/^t\d{8}-\d{2}$/.test(tag || "")) throw new Error("Matter source must be a verified tYYYYMMDD-NN snapshot");
  const clone = canonicalClonePath("meow-matter-esp", home);
  requireExistingClone(PRODUCT_REPOS["meow-matter-esp"], clone);
  const revision = fetchTag(clone, tag);
  const tagObject = git(clone, "rev-parse", `refs/tags/${tag}`);
  git(clone, "fetch", "--no-tags", "origin", "refs/heads/main:refs/remotes/origin/main");
  git(clone, "merge-base", "--is-ancestor", revision, "origin/main");
  assertSnapshot(clone, tag, revision, tagObject);
  const directory = path.join(releaseWorkRoot(workId, home), "meow-matter-esp");
  if (fs.existsSync(directory)) throw new Error(`Refusing existing Matter worktree: ${directory}`);
  fs.mkdirSync(path.dirname(directory), { recursive: true });
  git(clone, "worktree", "add", "--detach", directory, revision);
  return { directory, revision, tag, tagObject };
}
module.exports = { prepareMatterSources, assertSnapshot, git };
