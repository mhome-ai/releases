"use strict";

const { parseArgs } = require("node:util");
const { productSourceTag } = require("./mhome-root");

const NATIVE_PREFIXES = {
  nlr: "linux-arm64",
  nlx: "linux-amd64",
  nm: "macos",
  nw: "windows",
};

const DESKTOP_PREFIXES = {
  am: "macos",
  al: "linux",
  aw: "windows",
};

const DOCKER_PREFIXES = {
  dlr: "linux-arm64",
  dlx: "linux-amd64",
};

function stripRef(ref) {
  return String(ref || "").replace(/^refs\/tags\//, "");
}

function resolveProductTag(ref) {
  const tag = stripRef(ref);
  const native = /^(nlr|nlx|nm|nw)(\d+\.\d+\.\d+)$/.exec(tag);
  if (native) {
    const version = native[2];
    return {
      channel: "native",
      prefix: native[1],
      platform: NATIVE_PREFIXES[native[1]],
      version,
      sourceTag: productSourceTag(version),
      releaseTag: tag,
      withPallas: false,
      withMeowcore: true,
    };
  }
  const desktop = /^(am|al|aw)(\d+\.\d+\.\d+)$/.exec(tag);
  if (desktop) {
    const version = desktop[2];
    return {
      channel: "desktop",
      prefix: desktop[1],
      platform: DESKTOP_PREFIXES[desktop[1]],
      version,
      sourceTag: productSourceTag(version),
      releaseTag: `a${version}`,
      withPallas: true,
      withMeowcore: true,
    };
  }
  const docker = /^(dlr|dlx)(\d+\.\d+\.\d+)$/.exec(tag);
  if (docker) {
    const version = docker[2];
    return {
      channel: "docker",
      prefix: docker[1],
      platform: DOCKER_PREFIXES[docker[1]],
      version,
      sourceTag: productSourceTag(version),
      releaseTag: tag,
      withPallas: false,
      withMeowcore: true,
    };
  }
  throw new Error(`Invalid product release tag: ${tag}`);
}

if (require.main === module) {
  try {
    const { values } = parseArgs({
      options: {
        ref: { type: "string" },
      },
    });
    const result = resolveProductTag(values.ref);
    process.stdout.write(`channel=${result.channel}\n`);
    process.stdout.write(`prefix=${result.prefix}\n`);
    process.stdout.write(`platform=${result.platform}\n`);
    process.stdout.write(`version=${result.version}\n`);
    process.stdout.write(`sourceTag=${result.sourceTag}\n`);
    process.stdout.write(`releaseTag=${result.releaseTag}\n`);
    process.stdout.write(`withPallas=${result.withPallas}\n`);
    process.stdout.write(`withMeowcore=${result.withMeowcore}\n`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = {
  DESKTOP_PREFIXES,
  DOCKER_PREFIXES,
  NATIVE_PREFIXES,
  resolveProductTag,
};
