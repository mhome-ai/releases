"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const test = require("node:test");
const { prepareMatterSources, assertSnapshot, git } = require("./prepare-matter-sources");
const { cleanupReleaseSources } = require("./cleanup-release-sources");
const { resolveProductTag } = require("./resolve-product-tag");
const { selectRelease, archiveAsset } = require("./matter-release");

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "matter-release-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function write(root, name, value) {
  const file = path.join(root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value);
  return file;
}
function repository(root, name, tag, files = {}, annotated = true) {
  const seed = path.join(root, `${name}-seed`);
  fs.mkdirSync(seed);
  execFileSync("git", ["init", "-q", "-b", "main", seed]);
  git(seed, "config", "user.name", "Release Test");
  git(seed, "config", "user.email", "release@example.invalid");
  write(seed, ".gitignore", "build/\n");
  for (const [name, content] of Object.entries(files)) write(seed, name, content);
  git(seed, "add", "."); git(seed, "commit", "-qm", "source");
  if (annotated) git(seed, "tag", "-a", tag, "-m", tag);
  else git(seed, "tag", tag);
  const origin = path.join(root, `${name}.git`);
  execFileSync("git", ["clone", "--bare", "-q", seed, origin]);
  git(seed, "remote", "add", "origin", origin);
  return { directory: seed, origin, revision: git(seed, "rev-parse", "HEAD"), tag, tagObject: git(seed, "rev-parse", tag) };
}

test("Matter product tag selects only the matching verified source", () => {
  const tag = resolveProductTag("mec520261026-01");
  assert.equal(tag.channel, "matter");
  assert.equal(tag.sourceTag, "t20261026-01");
  assert.equal(tag.platform, "esp32c5");
  for (const invalid of ["mec51.2.3", "mec520261026-00", "r20261026-01"]) {
    assert.throws(() => resolveProductTag(invalid));
  }
});

test("source preparation preserves canonical checkout and detects a moved t tag", t => {
  const root = temporary(t);
  const source = repository(root, "source", "t20261026-01", { "version.txt": "1.2.3\n" });
  const clone = path.join(root, ".mhome/meow-matter-esp");
  fs.mkdirSync(path.dirname(clone));
  execFileSync("git", ["clone", "-q", source.origin, clone]);
  write(clone, "local-note.txt", "preserve canonical state");
  const prepared = prepareMatterSources({ tag: source.tag, workId: "owned-test", home: root });
  assert.equal(prepared.revision, source.revision);
  assert.equal(git(clone, "branch", "--show-current"), "main");
  assert.equal(fs.readFileSync(path.join(clone, "local-note.txt"), "utf8"), "preserve canonical state");
  assert.equal(fs.existsSync(path.join(prepared.directory, "local-note.txt")), false);
  git(source.directory, "tag", "-fa", source.tag, "-m", "changed annotation");
  git(source.directory, "push", "--force", "origin", source.tag);
  assert.throws(() => assertSnapshot(prepared.directory, prepared.tag, prepared.revision, prepared.tagObject), /moved/);
  cleanupReleaseSources(path.join(root, ".mhome/work/owned-test"), root);
  assert.equal(fs.existsSync(prepared.directory), false);
  assert.equal(fs.readFileSync(path.join(clone, "local-note.txt"), "utf8"), "preserve canonical state");
});

test("missing t never falls back to r, and lightweight tags are rejected", t => {
  const root = temporary(t);
  const source = repository(root, "source", "r20261026-01");
  const clone = path.join(root, ".mhome/meow-matter-esp");
  fs.mkdirSync(path.dirname(clone));
  execFileSync("git", ["clone", "-q", source.origin, clone]);
  assert.throws(() => prepareMatterSources({ tag: "r20261026-01", workId: "r", home: root }), /verified t/);
  assert.throws(() => prepareMatterSources({ tag: "t20261026-01", workId: "missing", home: root }), /not found/);
  git(source.directory, "tag", "t20261026-01");
  git(source.directory, "push", "origin", "t20261026-01");
  assert.throws(() => prepareMatterSources({ tag: "t20261026-01", workId: "light", home: root }), /annotated/);
});

test("existing firmware versions and malformed public assets fail closed", () => {
  const asset = { name: "meowlink-matter-esp32c5-1.2.3.tar.gz", state: "uploaded", digest: "sha256:" + "a".repeat(64) };
  const release = { tag_name: "mec520261026-01", draft: false, assets: [asset] };
  assert.equal(archiveAsset(release, asset.name), asset);
  assert.throws(() => selectRelease([release], "mec520261026-02", asset.name), /version already belongs/);
  assert.throws(() => archiveAsset({ ...release, assets: [] }, asset.name), /missing/);
  assert.throws(() => archiveAsset({ ...release, assets: [{ ...asset, state: "starter" }] }, asset.name), /Incomplete/);
  assert.throws(() => archiveAsset({ ...release, assets: [{ ...asset, digest: undefined }] }, asset.name), /Incomplete/);
});

test("verified-looking tags outside main cannot enter release preparation", t => {
  const root = temporary(t);
  const source = repository(root, "source", "t20261026-01");
  git(source.directory, "switch", "-c", "unreviewed");
  write(source.directory, "unreviewed.txt", "not on main");
  git(source.directory, "add", "."); git(source.directory, "commit", "-qm", "unreviewed");
  git(source.directory, "tag", "-a", "t20261026-02", "-m", "unreviewed");
  git(source.directory, "push", "origin", "t20261026-02");
  const clone = path.join(root, ".mhome/meow-matter-esp");
  fs.mkdirSync(path.dirname(clone));
  execFileSync("git", ["clone", "-q", source.origin, clone]);
  assert.throws(() => prepareMatterSources({ tag: "t20261026-02", workId: "unreviewed", home: root }));
  assert.equal(fs.existsSync(path.join(root, ".mhome/work/unreviewed/meow-matter-esp")), false);
});

test("publication verifies uploads, preserves public bytes and retries without rebuilding", t => {
  const root = temporary(t);
  const source = repository(root, "source", "t20261026-01", {
    "scripts/package-firmware.py": 'import pathlib, sys\na=sys.argv\np=pathlib.Path(a[a.index("--archive")+1])\nif a[1] == "pack": p.write_bytes(b"verified firmware")\nassert p.read_bytes() == b"verified firmware"\n',
    "scripts/build.sh": '#!/usr/bin/env bash\nset -euo pipefail\nmkdir -p build/release-psram_ble\nprintf "fixture compiler output\\n"\n',
  });
  const orchestrator = repository(root, "orchestrator", "mec520261026-01");
  const archive = write(root, "firmware.tar.gz", "verified firmware");
  const digest = "sha256:" + crypto.createHash("sha256").update("verified firmware").digest("hex");
  const state = { source, tag: orchestrator.tag, version: "1.2.3", orchestratorDirectory: orchestrator.directory,
    orchestrator: orchestrator.revision, orchestratorTagObject: orchestrator.tagObject,
    assetName: "meowlink-matter-esp32c5-1.2.3.tar.gz", archive, bundle: path.join(root, "manifest.bundle.json"), reuse: true };
  write(root, "matter-release.json", JSON.stringify(state));
  write(root, "gh-state.json", "[]");
  const gh = write(root, "bin/gh", `#!${process.execPath}\n` + `
const fs = require('node:fs'), path = require('node:path');
const root = process.env.MATTER_TEST_ROOT, args = process.argv.slice(2), db = path.join(root, 'gh-state.json');
const releases = JSON.parse(fs.readFileSync(db));
fs.appendFileSync(path.join(root, 'gh-calls.jsonl'), JSON.stringify(args) + '\\n');
if (args[0] === 'api') console.log(JSON.stringify([releases]));
else if (args[1] === 'create') releases.push({tag_name: args[2], draft: true, assets: []});
else if (args[1] === 'upload') {
  if (args.includes('--clobber')) throw Error('overwrite forbidden');
  releases[0].assets.push({name: ${JSON.stringify(state.assetName)}, state: 'uploaded', digest: ${JSON.stringify(digest)}});
} else if (args[1] === 'download') fs.writeFileSync(args[args.indexOf('--output') + 1], 'verified firmware');
else if (args[1] === 'edit') releases[0].draft = false;
else throw Error('unexpected gh command ' + args);
fs.writeFileSync(db, JSON.stringify(releases));
`);
  fs.chmodSync(gh, 0o755);
  const env = { ...process.env, WORK_ROOT: root, MATTER_TEST_ROOT: root,
    PATH: `${path.dirname(gh)}:${process.env.PATH}`, GITHUB_REPOSITORY: "test/releases" };
  for (const name of ["PLUGIN_CATALOG_PRIVATE_KEY_B64", "MEOW_NODE_TEST_PUBLIC_KEY", "GH_TOKEN", "GITHUB_TOKEN"]) delete env[name];
  const execute = action => execFileSync(process.execPath, [path.join(__dirname, "matter-release.js"), action], { env, stdio: "pipe" });
  execute("sign"); execute("build"); // Reuse needs neither signing credentials nor a toolchain.
  fs.writeFileSync(path.join(root, "matter-release.json"), JSON.stringify({ ...state, reuse: false }));
  fs.unlinkSync(archive);
  execute("build"); // Exercise compiler streaming and the transition into packaging.
  assert.equal(fs.readFileSync(archive, "utf8"), "verified firmware");
  fs.writeFileSync(path.join(root, "matter-release.json"), JSON.stringify(state));
  execute("publish");
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, "gh-state.json")))[0].draft, false);
  fs.unlinkSync(path.join(root, "matter-upload-verified.tar.gz"));
  fs.writeFileSync(path.join(root, "gh-calls.jsonl"), "");
  execute("publish");
  const calls = fs.readFileSync(path.join(root, "gh-calls.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(calls.some(args => ["create", "upload", "edit"].includes(args[1])), false);
  assert.equal(fs.readFileSync(archive, "utf8"), "verified firmware");
  fs.writeFileSync(archive, "wrong firmware");
  assert.throws(() => execute("publish"));
});
