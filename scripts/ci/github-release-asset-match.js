"use strict";

function shouldSkipUpload(asset, digest) {
  return Boolean(
    asset &&
      asset.state === "uploaded" &&
      typeof digest === "string" &&
      digest.startsWith("sha256:") &&
      asset.digest === digest
  );
}

function decide(assetsJson, name, digest) {
  const parsed = JSON.parse(assetsJson);
  const assets = Array.isArray(parsed.assets) ? parsed.assets : [];
  const asset = assets.find((entry) => entry && entry.name === name);
  return shouldSkipUpload(asset, digest) ? "skip" : "upload";
}

module.exports = { decide, shouldSkipUpload };

if (require.main === module) {
  const { parseArgs } = require("node:util");
  const { values } = parseArgs({
    options: {
      name: { type: "string" },
      digest: { type: "string" },
    },
  });
  if (!values.name || !values.digest) {
    throw new Error("--name and --digest are required");
  }
  let data = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    data += chunk;
  });
  process.stdin.on("end", () => {
    process.stdout.write(`${decide(data, values.name, values.digest)}\n`);
  });
}
