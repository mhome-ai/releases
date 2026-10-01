"use strict";

const { parseArgs } = require("node:util");
const { productSourceTag } = require("./mhome-root");

const NATIVE_PREFIXES = {
  nlr: "linux-arm64",
  nlx: "linux-x64",
  nmr: "darwin-arm64",
  nmx: "darwin-x64",
  nw: "windows",
};

const DESKTOP_PREFIXES = {
  am: "macos",
  al: "linux",
  aw: "windows",
};

const DOCKER_PREFIXES = {
  dlr: "linux-arm64",
  dlx: "linux-x64",
};

function stripRef(ref) {
  return String(ref || "").replace(/^refs\/tags\//, "");
}

function isCatalogStamp(value) {
  if (!/^\d{14}$/.test(String(value || ""))) return false;
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  const hour = Number(value.slice(8, 10));
  const minute = Number(value.slice(10, 12));
  const second = Number(value.slice(12, 14));
  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= 31 &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59
  );
}

function timestampRelease(tag, prefix, body, channel, platform, extras) {
  if (!isCatalogStamp(body)) {
    throw new Error(
      `${tag} must use ${prefix}YYYYMMDDHHMMSS; component versions come from source`
    );
  }
  return {
    channel,
    prefix,
    platform,
    version: body,
    sourceTag: "",
    sourceMode: "pin",
    releaseTag: tag,
    ...extras,
  };
}

function resolveProductTag(ref) {
  const tag = stripRef(ref);
  const pluginDocker = /^(pdlr|pdlx)(\d{14}|\d+\.\d+\.\d+)$/.exec(tag);
  if (pluginDocker) {
    return timestampRelease(
      tag,
      pluginDocker[1],
      pluginDocker[2],
      "plugin-docker",
      DOCKER_PREFIXES[pluginDocker[1].slice(1)],
      { withPallas: false, withMeowcore: false }
    );
  }
  const plugin = /^(pnmr|pnmx|pnlr|pnlx)(\d{14}|\d+\.\d+\.\d+)$/.exec(tag);
  if (plugin) {
    return timestampRelease(
      tag,
      plugin[1],
      plugin[2],
      "plugin",
      NATIVE_PREFIXES[plugin[1].slice(1)],
      { withPallas: false, withMeowcore: false }
    );
  }
  const native = /^(nlr|nlx|nmr|nmx|nw)(\d{14}|\d+\.\d+\.\d+)$/.exec(tag);
  if (native) {
    return timestampRelease(
      tag,
      native[1],
      native[2],
      "native",
      NATIVE_PREFIXES[native[1]],
      { withPallas: false, withMeowcore: true }
    );
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
      sourceMode: "tag",
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
      sourceMode: "tag",
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
    process.stdout.write(`sourceMode=${result.sourceMode}\n`);
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
