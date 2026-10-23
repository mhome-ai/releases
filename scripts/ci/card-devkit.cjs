const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const run = (cmd, args) =>
  execFileSync(cmd, args, {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

function provesSource(log, tag, commit) {
  return log
    .split(/\r?\n/)
    .some((line) =>
      line.endsWith(`Validated Card DevKit source: ${tag} ${commit}`)
    );
}

async function verifySource(directory) {
  const tag = process.env.SOURCE_TAG,
    commit = process.env.SOURCE_COMMIT;
  if (
    !/^v\d+\.\d+\.\d+$/.test(tag || "") ||
    !/^[a-f0-9]{40}$/.test(commit || "")
  )
    throw new Error("Expected exact source tag and commit");
  if (
    run("git", ["-C", directory, "rev-parse", "HEAD"]) !== commit ||
    `v${
      JSON.parse(await fs.readFile(path.join(directory, "package.json")))
        .version
    }` !== tag
  )
    throw new Error("Source identity mismatch");
  const runs = JSON.parse(
    run("gh", [
      "run",
      "list",
      "--repo",
      "mhome-ai/pallas-cat",
      "--workflow",
      "validate_release_tag.yml",
      "--event",
      "create",
      "--limit",
      "100",
      "--json",
      "databaseId,conclusion",
    ])
  );
  let verified = false;
  for (const candidate of runs.filter(
    (entry) => entry.conclusion === "success"
  )) {
    // create-event headSha can be the default branch. Check the actual checkout log.
    const log = run("gh", [
      "run",
      "view",
      String(candidate.databaseId),
      "--repo",
      "mhome-ai/pallas-cat",
      "--log",
    ]);
    if (provesSource(log, tag, commit)) {
      verified = true;
      break;
    }
  }
  if (!verified)
    throw new Error(
      "No successful release-tag validation proves this source checkout"
    );
}

function promoteIndex(index, entry) {
  if (index.schemaVersion !== 1 || !Array.isArray(index.versions))
    throw new Error("Invalid DevKit index");
  if (
    ![...index.versions, entry].every((item) =>
      /^\d+\.\d+\.\d+$/.test(item.version)
    )
  )
    throw new Error("Invalid DevKit version");
  const old = index.versions.find((item) => item.version === entry.version);
  if (old && JSON.stringify(old) !== JSON.stringify(entry))
    throw new Error("Published DevKit version changed");
  const versions = old ? [...index.versions] : [...index.versions, entry];
  versions.sort((a, b) => {
    const aa = a.version.split(".").map(Number),
      bb = b.version.split(".").map(Number);
    return aa[0] - bb[0] || aa[1] - bb[1] || aa[2] - bb[2];
  });
  return { schemaVersion: 1, latest: versions.at(-1).version, versions };
}

async function publish(directory, { command = run, fetcher = fetch } = {}) {
  const bucket =
    process.env.INSTALL_DISTRIBUTION_BUCKET || "mhome-install-distribution";
  const base =
    process.env.INSTALL_DISTRIBUTION_BASE_URL || "https://install.mhome.ai";
  if (new URL(base).protocol !== "https:")
    throw new Error("Distribution requires HTTPS");
  const manifestBytes = await fs.readFile(path.join(directory, "devkit.json"));
  const manifest = JSON.parse(manifestBytes);
  if (
    manifest.schemaVersion !== 1 ||
    !/^\d+\.\d+\.\d+$/.test(manifest.version) ||
    !manifest.files?.length
  )
    throw new Error("Invalid DevKit manifest");
  const prefix = `card-devkit/${manifest.version}/`;
  if (
    new Set(manifest.files.map((file) => file.path)).size !==
      manifest.files.length ||
    manifest.files.some((file) => file.path === "devkit.json")
  )
    throw new Error("Duplicate release file path");
  const inventory = [
    ...manifest.files,
    {
      path: "devkit.json",
      sizeBytes: manifestBytes.length,
      sha256: sha(manifestBytes),
    },
  ];
  for (const file of inventory) {
    if (!/^[a-zA-Z0-9.-]+$/.test(file.path))
      throw new Error("Invalid release file path");
    const source = path.join(directory, file.path),
      bytes = await fs.readFile(source);
    if (bytes.length !== file.sizeBytes || sha(bytes) !== file.sha256)
      throw new Error(`Artifact changed: ${file.path}`);
    const contentType = file.path.endsWith(".json")
      ? "application/json"
      : file.path.endsWith(".tgz")
      ? "application/gzip"
      : "text/plain; charset=utf-8";
    try {
      command("aws", [
        "s3api",
        "put-object",
        "--bucket",
        bucket,
        "--key",
        prefix + file.path,
        "--body",
        source,
        "--content-type",
        contentType,
        "--cache-control",
        "public,max-age=31536000,immutable",
        "--if-none-match",
        "*",
      ]);
    } catch (error) {
      if (!String(error.stderr || error.message).includes("PreconditionFailed"))
        throw error;
      const existing = path.join(directory, ".existing");
      command("aws", [
        "s3api",
        "get-object",
        "--bucket",
        bucket,
        "--key",
        prefix + file.path,
        existing,
      ]);
      if (sha(await fs.readFile(existing)) !== file.sha256)
        throw new Error(`Immutable DevKit file differs: ${file.path}`);
      await fs.unlink(existing);
    }
    const response = await fetcher(`${base}/${prefix}${file.path}`, {
      signal: AbortSignal.timeout(30000),
    });
    if (
      !response.ok ||
      sha(Buffer.from(await response.arrayBuffer())) !== file.sha256
    )
      throw new Error(`Public delivery verification failed: ${file.path}`);
  }
  const indexFile = path.join(directory, ".index.json");
  let index = { schemaVersion: 1, versions: [] },
    etag;
  try {
    const result = JSON.parse(
      command("aws", [
        "s3api",
        "get-object",
        "--bucket",
        bucket,
        "--key",
        "card-devkit/index.json",
        indexFile,
      ])
    );
    etag = result.ETag;
    if (!etag) throw new Error("Missing index ETag");
    index = JSON.parse(await fs.readFile(indexFile));
  } catch (error) {
    if (!/NoSuchKey|\(404\)/.test(String(error.stderr || error.message)))
      throw error;
  }
  const next = promoteIndex(index, {
    version: manifest.version,
    manifestUrl: `${base}/${prefix}devkit.json`,
    sha256: sha(manifestBytes),
  });
  await fs.writeFile(indexFile, JSON.stringify(next, null, 2) + "\n");
  command("aws", [
    "s3api",
    "put-object",
    "--bucket",
    bucket,
    "--key",
    "card-devkit/index.json",
    "--body",
    indexFile,
    "--content-type",
    "application/json",
    "--cache-control",
    "no-cache",
    ...(etag ? ["--if-match", etag] : ["--if-none-match", "*"]),
  ]);
  const response = await fetcher(`${base}/card-devkit/index.json`, {
    signal: AbortSignal.timeout(30000),
    cache: "no-store",
  });
  if (
    !response.ok ||
    sha(Buffer.from(await response.arrayBuffer())) !==
      sha(await fs.readFile(indexFile))
  )
    throw new Error("Published index delivery verification failed");
  await fs.unlink(indexFile);
  return next;
}
module.exports = { verifySource, publish, promoteIndex, provesSource };
if (require.main === module) {
  const action =
    process.argv[2] === "verify-source"
      ? verifySource
      : process.argv[2] === "publish"
      ? publish
      : null;
  if (!action) throw new Error("Expected verify-source or publish");
  action(process.argv[3])
    .then((value) => {
      if (value) console.log(JSON.stringify(value));
    })
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
