"use strict";

const { parseArgs } = require("node:util");

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

function isAttemptId(value) {
  const match = /^(\d{4})(\d{2})(\d{2})-(\d{2})$/.exec(String(value || ""));
  if (!match) return false;
  const month = Number(match[2]);
  const day = Number(match[3]);
  const index = Number(match[4]);
  return month >= 1 && month <= 12 && day >= 1 && day <= 31 && index >= 1 && index <= 99;
}

function attemptSourceTag(attempt) {
  return `t${attempt}`;
}

function attemptRelease(tag, prefix, body, channel, platform, extras) {
  if (!isAttemptId(body)) {
    throw new Error(
      `${tag} must use ${prefix}YYYYMMDD-NN; component versions come from source`
    );
  }
  return {
    channel,
    prefix,
    platform,
    version: body,
    sourceTag: attemptSourceTag(body),
    sourceMode: "attempt",
    releaseTag: tag,
    ...extras,
  };
}

function resolveProductTag(ref) {
  const tag = stripRef(ref);
  const pluginDocker = /^(pdlr|pdlx)(\d{8}-\d{2}|\d{14}|\d+\.\d+\.\d+)$/.exec(tag);
  if (pluginDocker) {
    return attemptRelease(
      tag,
      pluginDocker[1],
      pluginDocker[2],
      "plugin-docker",
      DOCKER_PREFIXES[pluginDocker[1].slice(1)],
      { withPallas: false, withMeowcore: false }
    );
  }
  const plugin = /^(pnmr|pnmx|pnlr|pnlx)(\d{8}-\d{2}|\d{14}|\d+\.\d+\.\d+)$/.exec(tag);
  if (plugin) {
    return attemptRelease(
      tag,
      plugin[1],
      plugin[2],
      "plugin",
      NATIVE_PREFIXES[plugin[1].slice(1)],
      { withPallas: false, withMeowcore: false }
    );
  }
  const native = /^(nlr|nlx|nmr|nmx|nw)(\d{8}-\d{2}|\d{14}|\d+\.\d+\.\d+)$/.exec(tag);
  if (native) {
    return attemptRelease(
      tag,
      native[1],
      native[2],
      "native",
      NATIVE_PREFIXES[native[1]],
      { withPallas: false, withMeowcore: true }
    );
  }
  const desktop = /^(am|al|aw)(\d{8}-\d{2}|\d+\.\d+\.\d+)$/.exec(tag);
  if (desktop) {
    return attemptRelease(
      tag,
      desktop[1],
      desktop[2],
      "desktop",
      DESKTOP_PREFIXES[desktop[1]],
      { withPallas: true, withMeowcore: true }
    );
  }
  const docker = /^(dlr|dlx)(\d{8}-\d{2}|\d+\.\d+\.\d+)$/.exec(tag);
  if (docker) {
    return attemptRelease(
      tag,
      docker[1],
      docker[2],
      "docker",
      DOCKER_PREFIXES[docker[1]],
      { withPallas: false, withMeowcore: true }
    );
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
  attemptSourceTag,
  isAttemptId,
  resolveProductTag,
};
