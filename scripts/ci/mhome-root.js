"use strict";

const os = require("node:os");
const path = require("node:path");

const PRODUCT_REPOS = {
  baycat: {
    name: "baycat",
    repository: "mhome-ai/baycat",
    defaultBranch: "master",
  },
  "meowcore-rust": {
    name: "meowcore-rust",
    repository: "mhome-ai/meowcore-rust",
    defaultBranch: "main",
  },
  "pallas-cat": {
    name: "pallas-cat",
    repository: "mhome-ai/pallas-cat",
    defaultBranch: "master",
  },
};

function mhomeRoot(home = os.homedir()) {
  return path.resolve(home, ".mhome");
}

function canonicalClonePath(name, home = os.homedir()) {
  return path.join(mhomeRoot(home), name);
}

function releaseWorkRoot(workId, home = os.homedir()) {
  if (!workId || /[\\/]/.test(workId) || workId === "." || workId === "..") {
    throw new Error(`invalid release work id: ${workId}`);
  }
  return path.join(mhomeRoot(home), "work", workId);
}

function productSourceTag(version) {
  if (!/^\d+\.\d+\.\d+$/.test(String(version || ""))) {
    throw new Error(`invalid product version: ${version}`);
  }
  return `v${version}`;
}

module.exports = {
  PRODUCT_REPOS,
  canonicalClonePath,
  mhomeRoot,
  productSourceTag,
  releaseWorkRoot,
};
