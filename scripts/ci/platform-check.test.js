"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { runChecks, validateProfile } = require("./platform-check");

const git = (dir, ...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: "pipe" }).trim();
function setup(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "fixed-platform-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  function repo(name, tag, files) {
    const seed = path.join(home, `seed-${name}`);
    const origin = path.join(home, `${name}.git`);
    const clone = path.join(home, ".mhome", name);
    fs.mkdirSync(seed);
    git(seed, "init", "-q", "-b", name === "baycat" ? "master" : "main");
    git(seed, "config", "user.name", "Platform fixture");
    git(seed, "config", "user.email", "fixture@example.invalid");
    for (const [file, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(seed, file)), { recursive: true });
      fs.writeFileSync(path.join(seed, file), content);
    }
    git(seed, "add", "."); git(seed, "commit", "-qm", "fixed source");
    git(seed, "tag", "-a", tag, "-m", "verified fixture");
    git(home, "clone", "--bare", "-q", seed, origin);
    fs.mkdirSync(path.dirname(clone), { recursive: true });
    git(home, "clone", "-q", origin, clone);
    return { clone, commit: git(seed, "rev-parse", "HEAD"), tag };
  }
  const agent = repo("agent", "v0.1.0", { "Cargo.toml": '[workspace.package]\nversion = "0.1.0"\n' });
  const core = repo("meowcore-rust", "v1.0.0", { "release/sources/agent.json": JSON.stringify({
    schemaVersion: 1, repository: "mhome-ai/agent", version: "0.1.0", commit: agent.commit,
  }) });
  const baycat = repo("baycat", "t20261127-01", {
    ".gitignore": "/build/\n",
    "scripts/release/check-foundation-pins.js": "process.exit(0);\n",
    "scripts/release/linux/fixture.test.js": "// fixture, not executed\n",
    "release/sources/dependencies.json": JSON.stringify({ sources: { meowcoreRust: { commit: core.commit, version: "1.0.0" } } }),
  });
  const integration = repo("integration", "t20261127-02", { "source": "fixed plugin source" });
  const profile = { schemaVersion: 1, roots: Object.fromEntries(
    Object.entries({ baycat, integration }).map(([name, { tag, commit }]) => [name, { tag, commit }]),
  ) };
  const workId = "platform-check-123-1";
  return { home, workId, profile, repos: { baycat, integration, core, agent }, work: path.join(home, ".mhome/work", workId) };
}

for (const platform of ["linux-x64", "linux-arm64"]) test(`${platform}: checks frozen roots and derived Core/Agent, never mutable originals`, (t) => {
  const fixture = setup(t);
  const { home, work, workId, profile, repos } = fixture;
  const calls = [];
  const originalHeads = new Map();
  for (const { clone } of Object.values(repos)) {
    fs.writeFileSync(path.join(clone, "later-source"), "new main is outside the profile");
    git(clone, "add", "later-source");
    git(clone, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "ongoing development");
    originalHeads.set(clone, git(clone, "rev-parse", "HEAD"));
    fs.writeFileSync(path.join(clone, "ongoing-work"), "preserve");
  }
  const result = runChecks({ home, workId, profile, platform, run: (command, args, options) => {
    calls.push([command, args, options]);
    assert.equal(path.dirname(options.cwd), work);
    assert.notEqual(options.cwd, repos.baycat.clone);
    assert.equal(git(path.join(work, "agent"), "rev-parse", "HEAD"), repos.agent.commit);
    assert.equal(git(path.join(work, "meowcore-rust"), "rev-parse", "HEAD"), repos.core.commit);
    for (const name of ["baycat", "integration"])
      assert.equal(git(path.join(work, name), "rev-parse", "HEAD"), profile.roots[name].commit);
  } });
  assert.equal(result.agent, repos.agent.commit);
  assert.equal(result.core, repos.core.commit);
  assert.equal(calls.length, 4);
  assert.deepEqual(calls[3][1], ["scripts/release/quality-gate.sh", "--expect-target",
    platform === "linux-x64" ? "x86_64-unknown-linux-gnu" : "aarch64-unknown-linux-gnu"]);
  assert.equal(fs.existsSync(work), false);
  for (const { clone } of Object.values(repos)) {
    assert.equal(git(clone, "rev-parse", "HEAD"), originalHeads.get(clone));
    assert.equal(fs.readFileSync(path.join(clone, "ongoing-work"), "utf8"), "preserve");
    assert.equal(git(clone, "worktree", "list", "--porcelain").match(/^worktree /gm).length, 1);
  }
});

for (const failure of ["baycat-sha", "integration-sha", "command", "missing-clone", "existing-work"]) test(`refuses/cleans failure: ${failure}`, (t) => {
  const { home, work, workId, profile, repos } = setup(t);
  let commands = 0;
  let owned;
  if (failure.endsWith("-sha")) profile.roots[failure.split("-")[0]].commit = "f".repeat(40);
  if (failure === "missing-clone") fs.renameSync(repos.integration.clone, repos.integration.clone + "-saved");
  if (failure === "existing-work") {
    fs.mkdirSync(work, { recursive: true });
    fs.writeFileSync(path.join(work, "keep"), "not owned");
  }
  assert.throws(() => runChecks({ home, workId, profile, platform: "linux-x64", onPrepared: (directory) => { owned = directory; }, run: () => {
    commands++;
    throw new Error("check failed");
  } }), /profile requires|check failed|runner is missing|EEXIST/);
  assert.equal(commands, failure === "command" ? 1 : 0);
  assert.equal(owned, failure === "existing-work" ? undefined : work);
  if (failure === "existing-work") assert.equal(fs.readFileSync(path.join(work, "keep"), "utf8"), "not owned");
  else assert.equal(fs.existsSync(work), false);
});

test("invalid profiles and Windows never create source work", () => {
  assert.throws(() => validateProfile({ schemaVersion: 1, roots: { baycat: null, integration: null } }), /requires/);
  assert.throws(() => runChecks({ profile: { schemaVersion: 1, roots: {
    baycat: { tag: "t20261127-01", commit: "a".repeat(40) },
    integration: { tag: "t20261127-02", commit: "b".repeat(40) },
  } }, platform: "windows-x64" }), /not verified/);
});
