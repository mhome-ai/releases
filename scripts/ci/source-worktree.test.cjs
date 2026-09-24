const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFileSync } = require("node:child_process");
const { prepare, cleanup } = require("./source-worktree.cjs");
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: "pipe" }).trim();
function setup(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "runner-sources-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, ".mhome");
  fs.mkdirSync(root);
  function repo(name, files) {
    const origin = path.join(base, `${name}-origin`);
    fs.mkdirSync(origin);
    git(origin, "init", "-q", "-b", "main");
    git(origin, "config", "user.name", "Fixture"); git(origin, "config", "user.email", "test@example.invalid");
    for (const [file, value] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(origin, file)), { recursive: true });
      fs.writeFileSync(path.join(origin, file), value);
    }
    git(origin, "add", "."); git(origin, "commit", "-qm", "initial");
    const revision = git(origin, "rev-parse", "HEAD");
    git(base, "clone", "-q", origin, path.join(root, name));
    return { origin, revision, clone: path.join(root, name) };
  }
  const args = { root, reference: "refs/heads/main", run: "123", job: "test", attempt: "1" };
  return { root, repo, args };
}

test("uses event SHA while preserving newer canonical main and cleans generated files", (t) => {
  const { root, repo, args } = setup(t);
  const source = repo("foundation", { "source.txt": "pinned" });
  fs.writeFileSync(path.join(source.origin, "later.txt"), "later");
  git(source.origin, "add", "."); git(source.origin, "commit", "-qm", "newer");
  git(source.clone, "pull", "--ff-only");
  const before = git(source.clone, "rev-parse", "HEAD");
  const output = prepare({ ...args, name: "foundation", revision: source.revision });
  assert.equal(git(output.MHOME_SOURCE_DIR, "rev-parse", "HEAD"), source.revision);
  assert.equal(fs.existsSync(path.join(output.MHOME_SOURCE_DIR, "later.txt")), false);
  assert.equal(git(source.clone, "rev-parse", "HEAD"), before);
  assert.equal(git(source.clone, "branch", "--show-current"), "main");
  fs.writeFileSync(path.join(output.MHOME_SOURCE_DIR, "generated.txt"), "build output");
  cleanup(output.MHOME_WORK_ROOT, root);
  assert.equal(fs.existsSync(output.MHOME_WORK_ROOT), false);
  assert.equal(git(source.clone, "worktree", "list", "--porcelain").match(/^worktree /gm).length, 1);
});

test("missing repositories fail and an existing task directory is never replaced", (t) => {
  const { root, repo, args } = setup(t);
  assert.throws(() => prepare({ ...args, name: "agent-cloud", revision: "a".repeat(40) }), /provision/);
  assert.equal(fs.existsSync(path.join(root, "agent-cloud")), false);
  const source = repo("foundation", { "source.txt": "pinned" });
  const work = path.join(root, "work/foundation-123-test-1");
  fs.mkdirSync(work, { recursive: true }); fs.writeFileSync(path.join(work, "owner.txt"), "other");
  assert.throws(() => prepare({ ...args, name: "foundation", revision: source.revision }), /existing work/);
  assert.equal(fs.readFileSync(path.join(work, "owner.txt"), "utf8"), "other");
  assert.throws(() => cleanup(root, root), /outside/);
});

test("consumer gets its exact Agent pin and partial preparation is rolled back", (t) => {
  const { root, repo, args } = setup(t);
  const helper = fs.readFileSync(path.resolve(__dirname, "../../../agent/scripts/consumer-source.cjs"), "utf8");
  const agent = repo("agent", { "Cargo.toml": '[workspace.package]\nversion = "0.11.5"\n', "scripts/consumer-source.cjs": helper });
  const pin = { schemaVersion: 1, repository: "mhome-ai/agent", version: "0.11.5", commit: agent.revision };
  const cloud = repo("agent-cloud", { "release/sources/agent.json": JSON.stringify(pin) });
  const output = prepare({ ...args, name: "agent-cloud", revision: cloud.revision });
  assert.equal(git(output.MHOME_AGENT_DIR, "rev-parse", "HEAD"), agent.revision);
  assert.equal(path.dirname(output.MHOME_AGENT_DIR), path.dirname(output.MHOME_SOURCE_DIR));
  cleanup(output.MHOME_WORK_ROOT, root);
  fs.writeFileSync(path.join(cloud.origin, "release/sources/agent.json"), JSON.stringify({ ...pin, version: "999.0.0" }));
  git(cloud.origin, "add", "."); git(cloud.origin, "commit", "-qm", "invalid pin");
  assert.throws(() => prepare({ ...args, name: "agent-cloud", revision: git(cloud.origin, "rev-parse", "HEAD") }), /version/);
  assert.equal(fs.existsSync(path.join(root, "work/agent-cloud-123-test-1")), false);
  for (const source of [agent, cloud]) assert.equal(git(source.clone, "worktree", "list", "--porcelain").match(/^worktree /gm).length, 1);
});

test("unknown commits fail without falling back to canonical HEAD", (t) => {
  const { root, repo, args } = setup(t);
  const source = repo("agent", { "source.txt": "current" });
  assert.throws(() => prepare({ ...args, name: "agent", revision: "a".repeat(40) }));
  assert.equal(fs.existsSync(path.join(root, "work/agent-123-test-1")), false);
  assert.equal(git(source.clone, "rev-parse", "HEAD"), source.revision);
});
