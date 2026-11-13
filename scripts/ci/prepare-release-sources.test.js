"use strict";

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { cleanupReleaseSources } = require("./cleanup-release-sources");
const { main: nativeInputs, readPreparedInputs, checkInputs } = require("./native-ffmpeg-inputs");
const {
  fetchTag,
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

test("Native freezes once and hands verified macOS and Linux inputs to the packer without a download token", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mhome-native-inputs-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const agent = createOrigin(t, {
    name: "agent", branch: "main", tag: "v0.11.5",
    files: { "Cargo.toml": '[workspace.package]\nversion = "0.11.5"\n' },
  });
  const meowcore = createOrigin(t, {
    name: "meowcore", branch: "main", tag: "v1.0.12",
    files: { "release/sources/agent.json": JSON.stringify({
      schemaVersion: 1, repository: "mhome-ai/agent", version: "0.11.5", commit: agent.commit,
    }) },
  });
  const bundle = path.resolve(__dirname, "../../../baycat/scripts/bundle");
  const targets = [
    ["nmr", "darwin-arm64"], ["nmx", "darwin-x64"],
    ["nlr", "linux-arm64"], ["nlx", "linux-x64"],
  ];
  const pinsByPlatform = {
    darwin: { version: "9.0.2-meow.1", recipeCommit: "a".repeat(40) },
    linux: { version: "9.0.2-meow.2", recipeCommit: "b".repeat(40) },
  };
  for (const pin of Object.values(pinsByPlatform)) {
    pin.repository = "mhome-ai/internal-releases";
    pin.platforms = {};
  }
  const assets = new Map();
  for (const [, platform] of targets) {
    const pins = pinsByPlatform[platform.split("-")[0]];
    const pin = pins.platforms[platform] = {};
    for (const [suffix, key] of [["", "archiveSha256"], ["-sources", "sourcesSha256"]]) {
      const name = `ffmpeg-${pins.version}-${platform}${suffix}.tar.gz`;
      const bytes = `fixture for ${name}`;
      assets.set(name, bytes);
      pin[key] = createHash("sha256").update(bytes).digest("hex");
    }
  }
  const baycat = createOrigin(t, {
    name: "baycat", branch: "master", tag: "t20261001-01",
    files: {
      ".gitignore": "/build/\n",
      "scripts/release/check-foundation-pins.js": "process.exit(0);\n",
      "release/sources/dependencies.json": JSON.stringify({ schemaVersion: 1, sources: {
        meowcoreRust: { repository: "mhome-ai/meowcore-rust", version: "1.0.12", commit: meowcore.commit },
      } }),
      "scripts/bundle/ffmpeg-macos-release.json": JSON.stringify(pinsByPlatform.darwin),
      "scripts/bundle/ffmpeg-linux-release.json": JSON.stringify(pinsByPlatform.linux),
      "scripts/bundle/verified-download-cache.js": fs.readFileSync(path.join(bundle, "verified-download-cache.js")),
    },
  });
  provisionClone(home, "agent", agent, "main");
  provisionClone(home, "meowcore-rust", meowcore, "main");
  provisionClone(home, "baycat", baycat, "master");

  const originalEnv = { PATH: process.env.PATH, GH_TOKEN: process.env.GH_TOKEN, GITHUB_TOKEN: process.env.GITHUB_TOKEN };
  t.after(() => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const actualGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const bin = path.join(home, "bin");
  const requestLog = path.join(home, "requested-assets");
  write(path.join(bin, "git"), `#!${process.execPath}
const assert = require('node:assert/strict');
assert.notEqual(process.env.GH_TOKEN, 'fixture-private-read');
const r = require('node:child_process').spawnSync(${JSON.stringify(actualGit)}, process.argv.slice(2), { stdio: 'inherit' });
process.exit(r.status ?? 1);
`);
  write(path.join(bin, "gh"), `#!${process.execPath}
const assert = require('node:assert/strict');
const fs = require('node:fs');
const [release, download, tag, repoFlag, repo, pattern, asset, output, target] = process.argv.slice(2);
assert.deepEqual([release, download, repoFlag, repo, pattern, output],
  ['release', 'download', '--repo', 'mhome-ai/internal-releases', '--pattern', '--output']);
assert.ok(asset.startsWith(tag + '-'));
assert.equal(process.env.GH_TOKEN, 'fixture-private-read');
assert.equal(process.env.GITHUB_TOKEN, undefined);
const bytes = ${JSON.stringify(Object.fromEntries(assets))}[asset];
assert.ok(bytes, asset);
fs.writeFileSync(target, bytes);
fs.appendFileSync(${JSON.stringify(requestLog)}, asset + '\\n');
`);
  for (const name of ["git", "gh"]) fs.chmodSync(path.join(bin, name), 0o755);
  process.env.PATH = `${bin}${path.delimiter}${originalEnv.PATH}`;
  for (const [prefix, platform] of targets) {
    const tag = `${prefix}20261001-01`;
    const root = path.join(home, ".mhome", "work", platform);
    nativeInputs(["prepare", root, tag, platform], home);
    assert.throws(() => checkInputs(readPreparedInputs(root, tag, platform, home)),
      /Missing or changed verified FFmpeg input/);
    process.env.GH_TOKEN = "fixture-private-read";
    process.env.GITHUB_TOKEN = "fixture-publisher";
    nativeInputs(["download", root, tag, platform], home);
    assert.equal(process.env.GH_TOKEN, undefined);
    const inputs = readPreparedInputs(root, tag, platform, home);
    assert.equal(inputs.revision, baycat.commit);
    checkInputs(inputs);
    for (const [name, digest] of inputs.files) {
      const target = path.join(root, name);
      assert.equal(inputs.cache.restoreVerifiedDownload({
        cacheRoot: inputs.cacheRoot, expectedSha256: digest, targetPath: target,
      }), true);
      assert.equal(fs.readFileSync(target, "utf8"), assets.get(name));
    }
    const damaged = inputs.cache.cacheObjectPath(inputs.cacheRoot, inputs.files[0][1]);
    fs.chmodSync(damaged, 0o644);
    fs.writeFileSync(damaged, "changed after verification");
    assert.throws(() => checkInputs(inputs), /Missing or changed verified FFmpeg input/);
    assert.throws(() => readPreparedInputs(root, tag, "windows", home), /matching target/);
    cleanupReleaseSources(root, home);
    assert.equal(fs.existsSync(root), false);
  }
  assert.deepEqual(fs.readFileSync(requestLog, "utf8").trim().split("\n"), [...assets.keys()]);
});

test("prepares sibling worktrees from product tags and leaves HEAD clones alone", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mhome-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const agent = createOrigin(t, {
    name: "agent", branch: "main", tag: "v0.11.5", files: {
      "Cargo.toml": '[workspace.package]\nversion = "0.11.5"\n',
    },
  });
  const agentClone = provisionClone(home, "agent", agent, "main");
  git(agentClone, "tag", "-d", "v0.11.5");
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
    tag: "t20261001-01",
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
    version: "20261001-01",
    workId: "nlr-test",
    withMeowcore: true,
    home,
  });
  assert.equal(git(result.agent_dir, "rev-parse", "HEAD"), agent.commit);
  assert.equal(git(result.agent_dir, "rev-parse", "v0.11.5^{commit}"), agent.commit);
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

test("checks out the Pallas version pinned by the Baycat snapshot", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mhome-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const pallas = createOrigin(t, {
    name: "pallas",
    branch: "master",
    tag: "v0.2.1",
    files: { "package.json": '{"version":"0.2.1"}\n' },
  });
  const baycat = createOrigin(t, {
    name: "baycat",
    branch: "master",
    tag: "t20261001-01",
    files: {
      "package.json": '{"version":"1.2.3"}\n',
      "scripts/release/check-foundation-pins.js": "process.exit(0);\n",
      "release/sources/dependencies.json": `${JSON.stringify(
        {
          schemaVersion: 1,
          sources: {
            pallasCat: {
              repository: "mhome-ai/pallas-cat",
              version: "0.2.1",
              commit: pallas.commit,
            },
          },
        },
        null,
        2
      )}\n`,
    },
  });
  provisionClone(home, "baycat", baycat, "master");
  provisionClone(home, "pallas-cat", pallas, "master");
  const result = prepareReleaseSources({
    version: "20261001-01",
    workId: "desktop-pallas",
    withMeowcore: false,
    withPallas: true,
    home,
  });
  assert.equal(git(result.pallas_dir, "rev-parse", "HEAD"), pallas.commit);
  const provenance = JSON.parse(
    fs.readFileSync(
      path.join(result.baycat_dir, "build/release-source-provenance.json"),
      "utf8"
    )
  );
  assert.equal(provenance.pallasCat.tag, "v0.2.1");
  assert.equal(provenance.baycat.tag, "t20261001-01");
  cleanupReleaseSources(result.source_root, home);
});

test("rejects a semver where an attempt snapshot is required", () => {
  assert.throws(
    () =>
      prepareReleaseSources({
        version: "1.2.3",
        workId: "old-version",
        withMeowcore: false,
        home: os.tmpdir(),
      }),
    /tYYYYMMDD-NN/
  );
});

test("fails when the runner was not provisioned with a clone", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mhome-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  assert.throws(
    () =>
      prepareReleaseSources({
        version: "20261001-01",
        workId: "missing-clone",
        withMeowcore: false,
        home,
      }),
    /provision ~\/\.mhome\/baycat/
  );
});

test("refuses an attempt tag and does not fall back from a missing verified snapshot", () => {
  assert.throws(
    () => fetchTag("/tmp/not-a-repo", "r20261001-01"),
    /refusing attempt tag r20261001-01/
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
        version: "20261001-01",
        workId: "missing-tag",
        withMeowcore: false,
        home,
      }),
    /remote tag t20261001-01 not found/
  );
});

test("does not use an r tag when the verified snapshot is absent", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mhome-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const baycat = createOrigin(t, {
    name: "baycat",
    branch: "master",
    tag: "r20261001-01",
    files: { "package.json": '{"version":"1.2.3"}\n' },
  });
  provisionClone(home, "baycat", baycat, "master");
  assert.throws(
    () =>
      prepareReleaseSources({
        version: "20261001-01",
        workId: "attempt-only",
        withMeowcore: false,
        home,
      }),
    /remote tag t20261001-01 not found/
  );
});

test("rejects a lightweight product tag", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mhome-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const baycat = createOrigin(t, {
    name: "baycat",
    branch: "master",
    tag: "t20261001-01",
    lightweightTag: true,
    files: { "package.json": '{"version":"1.2.3"}\n' },
  });
  provisionClone(home, "baycat", baycat, "master");
  assert.throws(
    () =>
      prepareReleaseSources({
        version: "20261001-01",
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
