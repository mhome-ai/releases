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

function invocation(workRoot, tag, platform, home) {
  const product = resolveProductTag(tag);
  if (product.channel !== "native" || product.platform !== platform ||
      !["darwin-arm64", "darwin-x64"].includes(platform)) {
    throw new Error("Expected a macOS Native tag and its matching target");
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
  const pinsFile = path.join(bundle, "ffmpeg-macos-release.json");
  const inputs = { revision: provenance.baycat.revision, spec: null };
  // Historical Native snapshots use the old public tool and need no secret.
  if (!fs.existsSync(pinsFile)) return inputs;
  const pins = readJson(pinsFile);
  if (pins.repository !== REPOSITORY || !/^\d+\.\d+\.\d+-meow\.[1-9]\d*$/.test(pins.version)) {
    throw new Error("Invalid frozen macOS FFmpeg release identity");
  }
  const { macosFfmpegSpec } = require(path.join(bundle, "ffmpeg-macos.js"));
  const spec = macosFfmpegSpec(pins.version, platform);
  if (!spec || !DIGEST.test(spec.archiveSha256) || !DIGEST.test(spec.sourcesSha256)) {
    throw new Error(`Missing frozen FFmpeg checksums for ${platform}`);
  }
  return {
    ...inputs,
    spec,
    files: [[spec.archiveName, spec.archiveSha256], [spec.sourcesName, spec.sourcesSha256]],
    cacheRoot: path.join(workRoot, "macos-downloads"),
    cache: require(path.join(bundle, "verified-download-cache.js")),
  };
}

function downloadInputs(workRoot, inputs, token) {
  if (!inputs.spec) return;
  if (!token) throw new Error("GPR_TOKEN is required for private macOS FFmpeg inputs");
  const temporary = fs.mkdtempSync(path.join(workRoot, "ffmpeg-download-"));
  try {
    for (const [name, digest] of inputs.files) {
      const target = path.join(temporary, name);
      try {
        execFileSync("gh", ["release", "download", inputs.spec.tag, "--repo", REPOSITORY,
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
  if (!inputs.spec) return;
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
  // The download step's credential is not inherited by the Git checks or
  // helpers loaded from the frozen product. Only gh release download gets it.
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
