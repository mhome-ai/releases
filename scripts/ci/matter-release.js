"use strict";
// Each action runs in a separate workflow step. Only sign receives the publisher
// secret, and only prepare/publish receive GitHub credentials. All source is trusted t source.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { resolveProductTag } = require("./resolve-product-tag");
const { prepareMatterSources, assertSnapshot, git } = require("./prepare-matter-sources");

function run(command, args, options = {}) {
  const output = execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], ...options });
  return typeof output === "string" ? output.trim() : "";
}
const digest = file => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const json = file => JSON.parse(fs.readFileSync(file, "utf8"));

function selectRelease(releases, tag, assetName) {
  for (const release of releases) {
    if (release.tag_name !== tag && release.assets.some(asset => asset.name === assetName)) {
      throw new Error(`Firmware version already belongs to ${release.tag_name}; advance version.txt for new source`);
    }
  }
  return releases.find(release => release.tag_name === tag);
}

function archiveAsset(release, assetName) {
  if (!release) return null;
  if (release.assets.some(asset => asset.name !== assetName)) throw new Error("Unexpected assets on Matter release");
  const asset = release.assets.find(entry => entry.name === assetName);
  if (asset && (asset.state !== "uploaded" || !/^sha256:[a-f0-9]{64}$/.test(asset.digest || ""))) {
    throw new Error("Incomplete release asset; inspect the draft upload before retrying");
  }
  if (!asset && !release.draft) throw new Error("Published Matter release is missing its firmware archive");
  return asset || null;
}

function context() {
  const root = process.env.WORK_ROOT;
  if (!root || !path.isAbsolute(root)) throw new Error("WORK_ROOT must be an absolute owned release directory");
  return { root, stateFile: path.join(root, "matter-release.json"), repo: process.env.GITHUB_REPOSITORY || "mhome-ai/releases" };
}

function listReleases(repo) {
  const query = '[.[][] | select(.tag_name | startswith("mec5")) | {tag_name, draft, assets: [.assets[] | {name, state, digest}]}]';
  return JSON.parse(run("gh", ["api", "--paginate", "--slurp", `repos/${repo}/releases?per_page=100`, "--jq", query],
    { maxBuffer: 16 * 1024 * 1024 })).flat();
}

function assertSource(state) {
  for (const [directory, revision] of [[state.source.directory, state.source.revision],
    [state.orchestratorDirectory, state.orchestrator]]) {
    if (git(directory, "rev-parse", "HEAD") !== revision || git(directory, "status", "--porcelain", "--untracked-files=all")) {
      throw new Error("Frozen Matter source or release orchestrator was modified");
    }
  }
  assertSnapshot(state.source.directory, state.source.tag, state.source.revision, state.source.tagObject);
  assertSnapshot(state.orchestratorDirectory, state.tag, state.orchestrator, state.orchestratorTagObject);
}

function packageArgs(state, action, archive = state.archive) {
  return [path.join(state.source.directory, "scripts/package-firmware.py"), action, "--archive", archive,
    "--source-tag", state.source.tag, "--tag-object", state.source.tagObject,
    "--orchestrator", state.orchestrator, "--release-tag", state.tag];
}

function verifyDownloaded(state, asset, destination, repo) {
  run("gh", ["release", "download", state.tag, "--repo", repo, "--pattern", state.assetName, "--output", destination]);
  if (`sha256:${digest(destination)}` !== asset.digest) throw new Error("Downloaded archive differs from GitHub asset digest");
  run("python3", packageArgs(state, "verify", destination));
}

function prepare(ctx) {
  if (fs.existsSync(ctx.stateFile)) throw new Error("Release state already exists");
  const product = resolveProductTag(process.env.RELEASE_TAG);
  if (product.channel !== "matter") throw new Error("Expected a mec5 Matter release tag");
  const source = prepareMatterSources({ tag: product.sourceTag, workId: process.env.WORK_ID });
  const version = fs.readFileSync(path.join(source.directory, "version.txt"), "utf8").trim();
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version) || version.length > 32) throw new Error("Invalid firmware version.txt");
  const orchestratorDirectory = process.env.RELEASES_DIR;
  const state = { source, version, tag: product.releaseTag, orchestratorDirectory,
    orchestrator: git(orchestratorDirectory, "rev-parse", "HEAD"),
    orchestratorTagObject: process.env.ORCHESTRATOR_TAG_OBJECT,
    assetName: `meowlink-matter-esp32c5-${version}.tar.gz`, reuse: false };
  const artifacts = path.join(ctx.root, "matter-artifacts");
  fs.mkdirSync(artifacts);
  state.archive = path.join(artifacts, state.assetName);
  state.bundle = path.join(artifacts, "manifest.bundle.json");
  assertSource(state);
  const release = selectRelease(listReleases(ctx.repo), state.tag, state.assetName);
  const asset = archiveAsset(release, state.assetName);
  if (asset) {
    verifyDownloaded(state, asset, state.archive, ctx.repo);
    state.reuse = true;
    console.log("Verified existing release archive; keeping original signed bytes and firmware");
  }
  fs.writeFileSync(ctx.stateFile, JSON.stringify(state, null, 2) + "\n");
}

function sign(state) {
  const encoded = process.env.PLUGIN_CATALOG_PRIVATE_KEY_B64;
  delete process.env.PLUGIN_CATALOG_PRIVATE_KEY_B64;
  if (state.reuse) return;
  assertSource(state);
  if (!encoded) throw new Error("Missing PLUGIN_CATALOG_PRIVATE_KEY_B64");
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "matter-sign-"));
  const key = path.join(temporary, "publisher.key");
  try {
    fs.writeFileSync(key, Buffer.from(encoded, "base64"), { mode: 0o600 });
    run("python3", [path.join(state.source.directory, "scripts/node-manifest.py"), "sign",
      "--bundle", state.bundle, "--secret-key", key]);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

function build(state) {
  if (state.reuse) return;
  assertSource(state);
  for (const key of ["PLUGIN_CATALOG_PRIVATE_KEY_B64", "MEOW_NODE_TEST_PUBLIC_KEY", "GH_TOKEN", "GITHUB_TOKEN"]) {
    if (process.env[key]) throw new Error(`Unexpected credential or test trust in build step: ${key}`);
  }
  run("bash", ["scripts/build.sh", "psram_ble"], { cwd: state.source.directory, stdio: "inherit",
    env: { ...process.env, MEOW_NODE_BUILD_MODE: "release", MEOW_NODE_MANIFEST_BUNDLE: state.bundle } });
  assertSource(state);
  run("python3", [...packageArgs(state, "pack"), "--build", path.join(state.source.directory, "build/release-psram_ble"),
    "--bundle", state.bundle]);
}

function publish(ctx, state) {
  assertSource(state);
  run("python3", packageArgs(state, "verify"));
  let release = selectRelease(listReleases(ctx.repo), state.tag, state.assetName);
  let asset = archiveAsset(release, state.assetName);
  if (!release) {
    const notes = path.join(ctx.root, "matter-notes.md");
    fs.writeFileSync(notes, `MeowLink Matter firmware ${state.version} for ESP32-C5 with 32 MB flash and 8 MB PSRAM.\n\n`
      + `Source: ${state.source.tag} (${state.source.revision}). ESP-IDF 5.5.5.\n\n`
      + "Archive contains the application, bootloader, partition table, initial OTA data, flash offsets, signed Node declaration and SHA-256/provenance record.\n"
      + "This release does not perform flashing or hardware acceptance. Preserve device identity and NVS when updating.\n");
    run("gh", ["release", "create", state.tag, "--repo", ctx.repo, "--verify-tag", "--draft", "--latest=false",
      "--title", `MeowLink Matter ${state.version} (ESP32-C5)`, "--notes-file", notes]);
    release = selectRelease(listReleases(ctx.repo), state.tag, state.assetName);
    if (!release || !release.draft) throw new Error("Expected the newly created draft release");
  }
  if (asset) {
    if (asset.digest !== `sha256:${digest(state.archive)}`) throw new Error("Existing firmware differs; refusing overwrite");
  } else {
    run("gh", ["release", "upload", state.tag, "--repo", ctx.repo, state.archive]);
  }
  release = selectRelease(listReleases(ctx.repo), state.tag, state.assetName);
  asset = archiveAsset(release, state.assetName);
  if (!asset) throw new Error("Uploaded firmware archive is missing");
  const downloaded = path.join(ctx.root, "matter-upload-verified.tar.gz");
  verifyDownloaded(state, asset, downloaded, ctx.repo);
  if (digest(downloaded) !== digest(state.archive)) throw new Error("Uploaded firmware bytes differ");
  assertSource(state);
  if (release.draft) run("gh", ["release", "edit", state.tag, "--repo", ctx.repo, "--draft=false", "--latest=false"]);
  console.log(`Verified Matter release ${state.tag}, firmware ${state.version}`);
}

function main(action) {
  const ctx = context();
  if (action === "prepare") return prepare(ctx);
  const state = json(ctx.stateFile);
  if (action === "sign") return sign(state);
  if (action === "build") return build(state);
  if (action === "publish") return publish(ctx, state);
  throw new Error("Expected prepare, sign, build or publish");
}
module.exports = { selectRelease, archiveAsset, packageArgs };
if (require.main === module) {
  try { main(process.argv[2]); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
