"use strict";

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { releaseWorkRoot } = require("./mhome-root");
const { resolveProductTag } = require("./resolve-product-tag");
const {
  prepareReleaseSources,
  requireCleanWorktree,
  verifyProductPins,
} = require("./prepare-release-sources");

const REPOSITORY = "mhome-ai/internal-releases";
const SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const OFFICIAL_VERSION = /^(?:0|[1-9][0-9]*)(?:\.(?:0|[1-9][0-9]*)){1,2}$/;
const HISTORICAL_PIN_FILES = {
  "darwin-arm64": "ffmpeg-macos-release.json",
  "darwin-x64": "ffmpeg-macos-release.json",
  "linux-arm64": "ffmpeg-linux-release.json",
  "linux-x64": "ffmpeg-linux-release.json",
};

function invocation(workRoot, tag, platform, home) {
  const product = resolveProductTag(tag);
  if (product.channel !== "native" || product.platform !== platform ||
      !Object.hasOwn(HISTORICAL_PIN_FILES, platform)) {
    throw new Error("Expected a Unix Native tag and its matching target");
  }
  const workId = path.basename(workRoot);
  if (workRoot !== releaseWorkRoot(workId, home) &&
      fs.realpathSync(workRoot) !== fs.realpathSync(releaseWorkRoot(workId, home))) {
    throw new Error("Expected an invocation-owned release work root");
  }
  return { product, workRoot, workId };
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function assertRevision(directory, revision) {
  if (!SHA.test(revision || "") || execFileSync("git", ["-C", directory, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim() !== revision) {
    throw new Error(`Frozen source revision changed: ${directory}`);
  }
}

function readPreparedInputs(workRoot, tag, platform, home) {
  const { product, workId } = invocation(workRoot, tag, platform, home);
  const baycatDir = path.join(workRoot, "baycat");
  const meowcoreDir = path.join(workRoot, "meowcore-rust");
  const agentDir = path.join(workRoot, "agent");
  const provenance = readJson(path.join(baycatDir, "build", "release-source-provenance.json"));
  if (provenance.schemaVersion !== 1 || provenance.kind !== "meow.release-source-provenance" ||
      provenance.workId !== workId || provenance.version !== product.version ||
      provenance.baycat?.tag !== product.sourceTag) {
    throw new Error("Prepared sources do not belong to this release invocation");
  }
  verifyProductPins({ version: product.version, baycatDir, meowcoreDir });
  assertRevision(baycatDir, provenance.baycat.revision);
  assertRevision(meowcoreDir, provenance.meowcoreRust?.revision);
  const agentPin = readJson(path.join(meowcoreDir, "release/sources/agent.json"));
  if (agentPin.commit !== provenance.agentRust?.revision) {
    throw new Error("Prepared Agent source does not match the Core pin");
  }
  requireCleanWorktree("agent", agentDir);
  assertRevision(agentDir, agentPin.commit);

  const bundle = path.join(baycatDir, "scripts", "bundle");
  const inputs = { revision: provenance.baycat.revision };
  const unified = path.join(bundle, "ffmpeg-release.json");
  const historical = path.join(bundle, HISTORICAL_PIN_FILES[platform]);
  let repository, pin;
  if (fs.existsSync(unified)) {
    const pins = readJson(unified);
    repository = pins.repository;
    const available = Object.entries(pins.releases).filter(([, release]) =>
      Object.hasOwn(release.platforms, platform)
    );
    if (available.length !== 1)
      throw new Error(`Expected one frozen FFmpeg input for ${platform}`);
    const [[version, release]] = available;
    if (OFFICIAL_VERSION.test(version) &&
        (Object.keys(release.platforms).length !== Object.keys(HISTORICAL_PIN_FILES).length ||
         Object.keys(HISTORICAL_PIN_FILES).some((target) => !Object.hasOwn(release.platforms, target))))
      throw new Error("An official FFmpeg release must cover all four targets");
    pin = { ...release.platforms[platform], version, recipeCommit: release.recipeCommit };
  } else if (fs.existsSync(historical)) {
    const pins = readJson(historical);
    repository = pins.repository;
    const target = pins.platforms?.[platform];
    if (target) pin = { ...target, version: pins.version, recipeCommit: pins.recipeCommit };
  } else {
    // Snapshots before private tool releases used publicly available inputs.
    return inputs;
  }
  const legacyVersion = platform.startsWith("darwin-") ? "9.0.2-meow.1" : "9.0.2-meow.2";
  if (repository !== REPOSITORY || !pin || !SHA.test(pin.recipeCommit || "") ||
      !(pin.version === legacyVersion || OFFICIAL_VERSION.test(pin.version || ""))) {
    throw new Error(`Invalid frozen FFmpeg release identity for ${platform}`);
  }
  if (!DIGEST.test(pin.archiveSha256 || "") || !DIGEST.test(pin.sourcesSha256 || "")) {
    throw new Error(`Missing frozen FFmpeg checksums for ${platform}`);
  }
  const releaseTag = `ffmpeg-${pin.version}`;
  const stem = `${releaseTag}-${platform}`;
  return {
    ...inputs,
    releaseTag,
    files: [[`${stem}.tar.gz`, pin.archiveSha256], [`${stem}-sources.tar.gz`, pin.sourcesSha256]],
    cacheRoot: path.join(workRoot, "native-downloads"),
    cache: require(path.join(bundle, "verified-download-cache.js")),
  };
}

function downloadInputs(workRoot, inputs, token) {
  if (!inputs.releaseTag) return;
  if (!token) throw new Error("GPR_TOKEN is required for private FFmpeg inputs");
  const temporary = fs.mkdtempSync(path.join(workRoot, "ffmpeg-download-"));
  try {
    for (const [name, digest] of inputs.files) {
      const target = path.join(temporary, name);
      try {
        execFileSync("gh", ["release", "download", inputs.releaseTag, "--repo", REPOSITORY,
          "--pattern", name, "--output", target], {
          env: { ...process.env, GH_TOKEN: token },
          stdio: ["ignore", "ignore", "pipe"],
          timeout: 120000,
        });
      } catch {
        throw new Error(`Cannot download pinned ${name}; check GPR_TOKEN read access to ${REPOSITORY}`);
      }
      inputs.cache.storeVerifiedDownload({ sourcePath: target, expectedSha256: digest, cacheRoot: inputs.cacheRoot });
    }
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

function checkInputs(inputs) {
  if (!inputs.releaseTag) return;
  for (const [name, digest] of inputs.files) {
    const file = inputs.cache.cacheObjectPath(inputs.cacheRoot, digest);
    if (!fs.lstatSync(file, { throwIfNoEntry: false })?.isFile() || inputs.cache.sha256File(file) !== digest) {
      throw new Error(`Missing or changed verified FFmpeg input: ${name}`);
    }
  }
}

function main([mode, workRoot, tag, platform], home) {
  if (mode === "prepare") {
    const { product, workId } = invocation(workRoot, tag, platform, home);
    prepareReleaseSources({ version: product.version, workId, withMeowcore: true, home });
    return;
  }
  if (mode !== "download" && mode !== "check") throw new Error("Expected prepare, download or check");
  // Strip the private credential before running source checks or loading
  // cache helpers. Only gh release download gets it.
  const token = mode === "download" ? process.env.GH_TOKEN : undefined;
  if (mode === "download") {
    delete process.env.GH_TOKEN;
    delete process.env.GITHUB_TOKEN;
  }
  const inputs = readPreparedInputs(workRoot, tag, platform, home);
  if (mode === "download") downloadInputs(workRoot, inputs, token);
  checkInputs(inputs);
  if (mode === "check") process.stdout.write(`${inputs.revision}\n`);
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { main, readPreparedInputs, checkInputs };
