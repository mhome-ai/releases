"use strict";

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { cleanupReleaseSources } = require("./cleanup-release-sources");
const { prepareReleaseSources } = require("./prepare-release-sources");

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
  const meowcore = createOrigin(t, {
    name: "meowcore",
    branch: "main",
    tag: "v1.0.12",
    files: {
      "Cargo.toml": '[package]\nname = "meowcore"\nversion = "1.0.12"\n',
    },
  });
  const baycat = createOrigin(t, {
    name: "baycat",
    branch: "master",
    tag: "v1.2.3",
    files: {
      "package.json": '{"version":"1.2.3"}\n',
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
