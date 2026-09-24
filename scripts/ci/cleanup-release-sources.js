"use strict";

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { mhomeRoot } = require("./mhome-root");

function fail(message) {
  throw new Error(message);
}

function git(repoDir, args) {
  const result = spawnSync("git", ["-C", repoDir, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    fail(
      `git ${args.join(" ")} failed in ${repoDir}: ${(result.stderr || "").trim()}`
    );
  }
  return result.stdout.trim();
}

function cleanupReleaseSources(sourceRoot, home = os.homedir()) {
  if (!sourceRoot) fail("release source root is required");
  const resolved = path.resolve(sourceRoot);
  const workRoot = path.join(mhomeRoot(home), "work");
  const parent = path.resolve(path.dirname(resolved));
  if (parent !== path.resolve(workRoot)) {
    fail(`refusing to remove release source outside ${workRoot}: ${resolved}`);
  }
  if (!fs.existsSync(resolved)) return;

  const names = ["baycat", "meowcore-rust", "agent", "pallas-cat", "releases"];
  for (const name of names) {
    const worktree = path.join(resolved, name);
    if (!fs.existsSync(worktree)) continue;
    const clone = path.join(mhomeRoot(home), name);
    if (fs.existsSync(path.join(clone, ".git"))) {
      const remove = spawnSync(
        "git",
        ["-C", clone, "worktree", "remove", "--force", worktree],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
      );
      if (remove.status !== 0) {
        git(clone, ["worktree", "prune"]);
      }
    }
  }
  fs.rmSync(resolved, { recursive: true, force: true });
}

if (require.main === module) {
  try {
    cleanupReleaseSources(process.argv[2]);
    process.stdout.write(`removed ${process.argv[2]}\n`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { cleanupReleaseSources };
