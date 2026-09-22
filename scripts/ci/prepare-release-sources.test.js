"use strict";

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { cleanupReleaseSources } = require("./cleanup-release-sources");
const {
  prepareReleaseSources,
  printOutputs,
} = require("./prepare-release-sources");

function git(repo, ...args) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function createOrigin(t, { name, branch, tag, files, lightweightTag }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `mhome-origin-${name}-`));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const seed = path.join(root, "seed");
  const bare = path.join(root, `${name}.git`);
  fs.mkdirSync(seed);
  execFileSync("git", ["init", "-q", "-b", branch], { cwd: seed });
  git(seed, "config", "user.name", "Release Test");
  git(seed, "config", "user.email", "release@example.invalid");
  for (const [relativePath, content] of Object.entries(files)) {
    write(path.join(seed, relativePath), content);
  }
  git(seed, "add", ".");
  git(seed, "commit", "-qm", "initial");
  if (tag && lightweightTag) git(seed, "tag", tag);
  else if (tag) git(seed, "tag", "-a", tag, "-m", tag);
  execFileSync("git", ["clone", "--bare", "-q", seed, bare]);
  return { bare, commit: git(seed, "rev-parse", "HEAD") };
}

function provisionClone(home, name, origin, branch) {
  const dest = path.join(home, ".mhome", name);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  execFileSync("git", ["clone", "--branch", branch, "-q", origin.bare, dest]);
  return dest;
}

test("prepares sibling worktrees from product tags and leaves HEAD clones alone", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mhome-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const agent = createOrigin(t, {
    name: "agent", branch: "main", files: {
      "Cargo.toml": '[workspace.package]\nversion = "0.11.5"\n',
    },
  });
  const agentClone = provisionClone(home, "agent-rust", agent, "main");
  git(agentClone, "config", "user.name", "Release Test");
  git(agentClone, "config", "user.email", "release@example.invalid");
  write(path.join(agentClone, "later.txt"), "newer source must not enter the release");
  git(agentClone, "add", "."); git(agentClone, "commit", "-qm", "later source");
  const currentAgentHead = git(agentClone, "rev-parse", "HEAD");
  const agentPin = JSON.stringify({ schemaVersion: 1, repository: "mhome-ai/agent", version: "0.11.5", commit: agent.commit });
  const meowcore = createOrigin(t, {
    name: "meowcore",
    branch: "main",
    tag: "v1.0.12",
    files: {
      "release/sources/agent.json": agentPin,
      "Cargo.toml": '[package]\nname = "meowcore"\nversion = "1.0.12"\n',
    },
  });
  const baycat = createOrigin(t, {
    name: "baycat",
    branch: "master",
    tag: "v1.2.3",
    files: {
      "package.json": '{"version":"1.2.3"}\n',
      "scripts/release/check-foundation-pins.js": "process.exit(0);\n",
      "release/sources/dependencies.json": `${JSON.stringify(
        {
          schemaVersion: 1,
          sources: {
            meowcoreRust: {
              repository: "mhome-ai/meowcore-rust",
              version: "1.0.12",
              commit: meowcore.commit,
            },
          },
        },
        null,
        2
      )}\n`,
    },
  });
  provisionClone(home, "baycat", baycat, "master");
  provisionClone(home, "meowcore-rust", meowcore, "main");
  const result = prepareReleaseSources({
    version: "1.2.3",
    workId: "nlr-test",
    withMeowcore: true,
    home,
  });
  assert.equal(git(result.agent_dir, "rev-parse", "HEAD"), agent.commit);
  assert.equal(git(agentClone, "branch", "--show-current"), "main");
  assert.equal(git(agentClone, "rev-parse", "HEAD"), currentAgentHead);
  assert.equal(fs.existsSync(path.join(result.agent_dir, "later.txt")), false);
  assert.equal(git(result.baycat_dir, "rev-parse", "HEAD"), baycat.commit);
  assert.equal(git(result.meowcore_dir, "rev-parse", "HEAD"), meowcore.commit);
  assert.equal(path.basename(path.dirname(result.meowcore_dir)), "nlr-test");
  assert.equal(
    git(path.join(home, ".mhome/baycat"), "branch", "--show-current"),
    "master"
  );
  assert.equal(
    git(path.join(home, ".mhome/meowcore-rust"), "branch", "--show-current"),
    "main"
  );
  assert.ok(
    fs.existsSync(
      path.join(result.baycat_dir, "build/release-source-provenance.json")
    )
  );
  cleanupReleaseSources(result.source_root, home);
  assert.equal(fs.existsSync(result.source_root), false);
  assert.equal(
    git(path.join(home, ".mhome/baycat"), "branch", "--show-current"),
    "master"
  );
});

test("fails when the runner was not provisioned with a clone", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mhome-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  assert.throws(
    () =>
      prepareReleaseSources({
        version: "1.2.3",
        workId: "missing-clone",
        withMeowcore: false,
        home,
      }),
    /provision ~\/\.mhome\/baycat/
  );
});

test("fails when the product source tag is missing", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mhome-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const baycat = createOrigin(t, {
    name: "baycat",
    branch: "master",
    files: { "package.json": '{"version":"1.2.3"}\n' },
  });
  provisionClone(home, "baycat", baycat, "master");
  assert.throws(
    () =>
      prepareReleaseSources({
        version: "1.2.3",
        workId: "missing-tag",
        withMeowcore: false,
        home,
      }),
    /remote tag v1\.2\.3 not found/
  );
});

test("rejects a lightweight product tag", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mhome-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const baycat = createOrigin(t, {
    name: "baycat",
    branch: "master",
    tag: "v1.2.3",
    lightweightTag: true,
    files: { "package.json": '{"version":"1.2.3"}\n' },
  });
  provisionClone(home, "baycat", baycat, "master");
  assert.throws(
    () =>
      prepareReleaseSources({
        version: "1.2.3",
        workId: "light-tag",
        withMeowcore: false,
        home,
      }),
    /must be annotated/
  );
});

test("prepare CLI prints stdout even when GITHUB_OUTPUT is set", () => {
  const file = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "mhome-gha-output-")),
    "github-output"
  );
  const previous = process.env.GITHUB_OUTPUT;
  process.env.GITHUB_OUTPUT = file;
  const originalWrite = process.stdout.write;
  let stdout = "";
  process.stdout.write = (chunk) => {
    stdout += String(chunk);
    return true;
  };
  try {
    printOutputs({ baycat_dir: "/tmp/baycat", source_root: "/tmp/work" });
  } finally {
    process.stdout.write = originalWrite;
    if (previous === undefined) delete process.env.GITHUB_OUTPUT;
    else process.env.GITHUB_OUTPUT = previous;
  }
  assert.match(stdout, /baycat_dir=\/tmp\/baycat/);
  assert.match(fs.readFileSync(file, "utf8"), /source_root=\/tmp\/work/);
});
