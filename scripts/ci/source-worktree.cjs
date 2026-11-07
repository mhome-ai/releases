#!/usr/bin/env node
"use strict";

// Shared bootstrap for self-hosted CI. Canonical clones are provisioned by the
// runner owner; jobs fetch objects and own only their detached worktrees.
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const REPOS = { foundation: "foundation", script: "script", "agent": "agent", "tiger": "tiger", "meowcore-rust": "meowcore-rust", integration: "integration" };
function git(cwd, ...args) {
  const attempts = args[0] === "fetch" ? 3 : 1;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return execFileSync("git", ["-C", cwd, ...args], {
        encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      }).trim();
    } catch (error) {
      if (attempt === attempts - 1) throw error;
      console.error(`${path.basename(cwd)}: git fetch failed; retry ${attempt + 2}/${attempts}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000 * (attempt + 1));
    }
  }
}

function requireClone(root, name) {
  const clone = path.join(root, name);
  if (!fs.existsSync(path.join(clone, ".git"))) throw new Error(`Runner is missing ${clone}; provision the repository before running CI`);
  const origin = git(clone, "remote", "get-url", "origin");
  const repository = /^(?:git@github\.com:|https:\/\/github\.com\/)([^\s]+?)(?:\.git)?\/?$/.exec(origin)?.[1];
  // Local remotes are useful for isolated integration tests and offline runners.
  if (repository ? repository !== `mhome-ai/${REPOS[name]}` : !path.isAbsolute(origin)) {
    throw new Error(`Unexpected origin for ${name}`);
  }
  return clone;
}

function cleanup(work, root) {
  if (path.dirname(path.resolve(work)) !== path.join(path.resolve(root), "work")) throw new Error("Refusing cleanup outside the runner work directory");
  if (!fs.existsSync(work)) return;
  const receipt = path.join(work, "source-worktrees.json");
  const entries = JSON.parse(fs.readFileSync(receipt, "utf8"));
  for (const name of entries.reverse()) {
    if (!Object.hasOwn(REPOS, name)) throw new Error("Invalid worktree receipt");
    const target = path.join(work, name);
    if (fs.existsSync(target)) git(path.join(root, name), "worktree", "remove", "--force", target);
    git(path.join(root, name), "worktree", "prune");
  }
  fs.unlinkSync(receipt);
  fs.rmdirSync(work); // Never recursively delete an unrecorded directory.
}

function prepare({ root, name, revision, reference, run, job, attempt }) {
  root = path.resolve(root);
  if (!Object.hasOwn(REPOS, name) || !/^[a-f0-9]{40}$/.test(revision)) throw new Error("Expected a known repository and full source commit");
  for (const value of [run, job, attempt]) if (!/^[a-zA-Z0-9_-]+$/.test(value || "")) throw new Error("Invalid CI run identity");
  if (!/^refs\/(heads|tags|pull)\/[a-zA-Z0-9_./-]+$/.test(reference || "")) throw new Error("Invalid event source ref");
  const clone = requireClone(root, name);
  const work = path.join(root, "work", `${name}-${run}-${job}-${attempt}`);
  if (fs.existsSync(work)) throw new Error(`Refusing to replace existing work: ${work}`);
  const entries = [];
  const receipt = path.join(work, "source-worktrees.json");
  fs.mkdirSync(work, { recursive: true });
  const record = () => fs.writeFileSync(receipt, JSON.stringify(entries) + "\n");
  record();
  const add = (repo, commit) => {
    const source = requireClone(root, repo);
    git(source, "fetch", "origin", commit);
    if (git(source, "rev-parse", `${commit}^{commit}`) !== commit) throw new Error("Fetched source does not match its commit");
    git(source, "worktree", "add", "--detach", path.join(work, repo), commit);
    entries.push(repo);
    record();
  };
  try {
    git(clone, "fetch", "origin", "+refs/heads/main:refs/remotes/origin/main", reference);
    add(name, revision);
    const directory = path.join(work, name);
    let agent = "";
    if (["tiger", "meowcore-rust"].includes(name)) {
      const pin = JSON.parse(fs.readFileSync(path.join(directory, "release/sources/agent.json"), "utf8"));
      if (pin.schemaVersion !== 1 || pin.repository !== "mhome-ai/agent" || !/^[a-f0-9]{40}$/.test(pin.commit || "")) throw new Error("Invalid Agent source pin");
      add("agent", pin.commit);
      agent = path.join(work, "agent");
      require(path.join(agent, "scripts/consumer-source.cjs")).verifyCheckout(directory, agent);
    }
    return { MHOME_WORK_ROOT: work, MHOME_SOURCE_DIR: directory, MHOME_AGENT_DIR: agent };
  } catch (error) {
    try { cleanup(work, root); } catch (cleanupError) { error.message += `; cleanup: ${cleanupError.message}`; }
    throw error;
  }
}

module.exports = { prepare, cleanup };
// CI callers invoke prepare/cleanup with explicit arguments and own their receipts.
