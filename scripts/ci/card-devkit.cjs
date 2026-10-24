const fs = require("node:fs/promises");
const sync = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const config = require("./card-devkit-runtime.json");
const BASE = "https://install.mhome.ai/card-devkit";
const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const run = (command, args, options = {}) =>
  execFileSync(command, args, {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  }).trim();
const exact = (version) => {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version))
    throw new Error("Expected exact version");
  return version;
};
async function download(url) {
  if (new URL(url).protocol !== "https:")
    throw new Error("Download requires HTTPS");
  const response = await fetch(url, { signal: AbortSignal.timeout(300000) });
  if (!response.ok)
    throw new Error(
      `Download returned HTTP ${response.status}: ${new URL(url).pathname}`
    );
  return Buffer.from(await response.arrayBuffer());
}
function verify(payload, signature, directory) {
  const file = path.join(directory, `.verify-${crypto.randomUUID()}`);
  sync.writeFileSync(file, payload);
  sync.writeFileSync(`${file}.minisig`, signature);
  try {
    run("minisign", [
      "-Vm",
      file,
      "-x",
      `${file}.minisig`,
      "-P",
      config.publicKey,
    ]);
  } finally {
    sync.rmSync(file, { force: true });
    sync.rmSync(`${file}.minisig`, { force: true });
  }
  return JSON.parse(payload);
}
function decode(bytes, directory) {
  const envelope = JSON.parse(bytes);
  if (
    envelope.schemaVersion !== 1 ||
    typeof envelope.payload !== "string" ||
    typeof envelope.signature !== "string"
  )
    throw new Error("Invalid signed envelope");
  return verify(envelope.payload, envelope.signature, directory);
}
async function sign(value, directory, existing) {
  const payload = JSON.stringify(value, null, 2) + "\n";
  if (existing) {
    const old = decode(existing, directory);
    if (JSON.stringify(old) !== JSON.stringify(value))
      throw new Error("Immutable signed payload differs");
    return existing;
  }
  if (!process.env.RUNTIME_CATALOG_PRIVATE_KEY_B64)
    throw new Error("Missing runtime distribution signing key");
  const file = path.join(directory, `.sign-${crypto.randomUUID()}`),
    key = `${file}.key`;
  await fs.writeFile(file, payload);
  await fs.writeFile(
    key,
    Buffer.from(process.env.RUNTIME_CATALOG_PRIVATE_KEY_B64, "base64"),
    { mode: 0o600 }
  );
  try {
    run("minisign", [
      "-Sm",
      file,
      "-s",
      key,
      "-x",
      `${file}.minisig`,
      "-t",
      "MeowLink Card DevKit",
    ]);
    const signature = await fs.readFile(`${file}.minisig`, "utf8");
    verify(payload, signature, directory);
    return Buffer.from(
      JSON.stringify({ schemaVersion: 1, payload, signature }) + "\n"
    );
  } finally {
    await Promise.all(
      [file, key, `${file}.minisig`].map((item) => fs.rm(item, { force: true }))
    );
  }
}
async function existing(url) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(30000),
    cache: "no-store",
  });
  if (response.status === 404) return undefined;
  if (!response.ok)
    throw new Error(
      `Could not establish publication state: HTTP ${response.status}`
    );
  return Buffer.from(await response.arrayBuffer());
}
async function verifySource(directory, { command = run } = {}) {
  const tag = process.env.SOURCE_TAG,
    commit = process.env.SOURCE_COMMIT;
  const version = JSON.parse(
    await fs.readFile(
      path.join(directory, "src/ui-kit/cards/devkit/package.json")
    )
  ).version;
  if (
    tag !== `card-devkit-v${exact(version)}` ||
    !/^[a-f0-9]{40}$/.test(commit || "") ||
    command("git", ["-C", directory, "rev-parse", "HEAD"]) !== commit
  )
    throw new Error(
      "DevKit source tag, package version and frozen commit must match"
    );
  if (
    command("git", [
      "-C",
      directory,
      "status",
      "--porcelain",
      "--untracked-files=no",
    ])
  )
    throw new Error("Frozen DevKit source is dirty");
  // This workflow checks the frozen DevKit itself; it does not depend on old App workflow logs.
  return { tag, commit };
}
async function inventory(directory, names) {
  return Promise.all(
    names.map(async (name) => {
      const bytes = await fs.readFile(path.join(directory, name));
      return { path: name, size: bytes.length, sha256: sha(bytes) };
    })
  );
}
async function prepare(
  directory,
  {
    downloadFile = download,
    command = run,
    existingEnvelope = existing,
    signer = sign,
  } = {}
) {
  const built = JSON.parse(
    await fs.readFile(path.join(directory, "devkit-build.json"))
  );
  exact(built.version);
  exact(process.env.CARD_ACCEPTANCE_CLI_VERSION);
  if (!built.source || !/^[a-f0-9]{40}$/.test(process.env.GITHUB_SHA || ""))
    throw new Error("Missing frozen source provenance");
  const nodeBase = `https://nodejs.org/dist/v${config.nodeVersion}`;
  const sums = await downloadFile(`${nodeBase}/SHASUMS256.txt`);
  await fs.writeFile(path.join(directory, "node-SHASUMS256.txt"), sums);
  await fs.writeFile(
    path.join(directory, "node-SHASUMS256.txt.sig"),
    await downloadFile(`${nodeBase}/SHASUMS256.txt.sig`)
  );
  if (!process.env.NODE_RELEASE_KEYRING)
    throw new Error("Configure the pinned official Node release keyring");
  command("gpgv", [
    "--keyring",
    process.env.NODE_RELEASE_KEYRING,
    path.join(directory, "node-SHASUMS256.txt.sig"),
    path.join(directory, "node-SHASUMS256.txt"),
  ]);
  const platforms = {},
    acceptance = {};
  for (const [platform, pin] of Object.entries(config.platforms)) {
    const name = `node-v${config.nodeVersion}-${platform}.${
      platform === "win-x64" ? "zip" : "tar.gz"
    }`;
    if (!sums.toString().split(/\r?\n/).includes(`${pin.sha256}  ${name}`))
      throw new Error(
        `Node upstream checksum differs from source pin: ${platform}`
      );
    const bytes = await downloadFile(`${nodeBase}/${name}`);
    if (sha(bytes) !== pin.sha256)
      throw new Error("Node archive integrity mismatch");
    const upstream = path.join(directory, name);
    await fs.writeFile(upstream, bytes);
    const output = `node-${platform}.tar.gz`;
    command("python3", [
      path.join(__dirname, "card-node-archive.py"),
      upstream,
      path.join(directory, output),
    ]);
    await fs.unlink(upstream);
    const [asset] = await inventory(directory, [output]);
    platforms[platform] = {
      nodeVersion: config.nodeVersion,
      npmVersion: config.npmVersion,
      minimumOs: pin.minimumOs,
      asset: {
        url: `${BASE}/${built.version}/${output}`,
        size: asset.size,
        sha256: asset.sha256,
      },
    };
    // Freeze the exact signed, already released CLI artifact before platform acceptance starts.
    const nativePlatform = platform === "win-x64" ? "windows" : platform;
    const catalogUrl = `https://install.mhome.ai/runtime/stable/${nativePlatform}/catalog.json`;
    const catalog = await downloadFile(catalogUrl),
      signature = await downloadFile(`${catalogUrl}.minisig`);
    const verified = verify(catalog, signature.toString(), directory);
    const client = verified.components?.client;
    const assetPlatform = platform === "win-x64" ? "windows-x64" : platform;
    const cliAsset = client?.assets?.[assetPlatform];
    if (
      client?.version !== process.env.CARD_ACCEPTANCE_CLI_VERSION ||
      !cliAsset
    )
      throw new Error(`Publish the requested meow CLI on ${platform} first`);
    acceptance[platform] = {
      version: client.version,
      asset: cliAsset,
      source: client.source,
    };
  }
  await fs.writeFile(
    path.join(directory, "acceptance.json"),
    JSON.stringify(acceptance, null, 2) + "\n"
  );
  const files = await inventory(directory, [
    ...built.files.map((file) => file.path),
    ...Object.keys(platforms).map((p) => `node-${p}.tar.gz`),
    "node-SHASUMS256.txt",
    "node-SHASUMS256.txt.sig",
    "acceptance.json",
  ]);
  const devkit = files.find((file) => file.path === "devkit.tar.gz");
  const manifest = {
    schemaVersion: 1,
    kind: "meow.card.devkit",
    version: built.version,
    workerProtocol: built.workerProtocol,
    minimumCliVersion: built.minimumCliVersion,
    source: built.source,
    orchestratorCommit: process.env.GITHUB_SHA,
    devkit: {
      url: `${BASE}/${built.version}/devkit.tar.gz`,
      size: devkit.size,
      sha256: devkit.sha256,
    },
    platforms,
    files,
  };
  const prior = await existingEnvelope(`${BASE}/${built.version}/devkit.json`);
  const bytes = await signer(manifest, directory, prior);
  await fs.writeFile(path.join(directory, "devkit.json"), bytes);
  return manifest;
}
function promoteIndex(index, entry) {
  if (
    index.schemaVersion !== 1 ||
    index.kind !== "meow.card.devkit.index" ||
    !Array.isArray(index.versions)
  )
    throw new Error("Invalid DevKit index");
  [...index.versions, entry].forEach((item) => exact(item.version));
  const old = index.versions.find((item) => item.version === entry.version);
  if (old && JSON.stringify(old) !== JSON.stringify(entry))
    throw new Error("Published DevKit version changed");
  const versions = old ? [...index.versions] : [...index.versions, entry];
  versions.sort((a, b) => {
    const aa = a.version.split(".").map(Number),
      bb = b.version.split(".").map(Number);
    return aa[0] - bb[0] || aa[1] - bb[1] || aa[2] - bb[2];
  });
  return {
    schemaVersion: 1,
    kind: "meow.card.devkit.index",
    latest: versions.at(-1).version,
    versions,
  };
}
async function publish(
  directory,
  {
    command = run,
    fetcher = fetch,
    verifyEnvelope = decode,
    promote = false,
    signer = sign,
  } = {}
) {
  const bucket =
    process.env.INSTALL_DISTRIBUTION_BUCKET || "mhome-install-distribution";
  const manifestBytes = await fs.readFile(path.join(directory, "devkit.json"));
  const manifest = verifyEnvelope(manifestBytes, directory);
  exact(manifest.version);
  if (
    manifest.schemaVersion !== 1 ||
    manifest.kind !== "meow.card.devkit" ||
    !manifest.files?.length
  )
    throw new Error("Invalid DevKit manifest");
  const prefix = `card-devkit/${manifest.version}/`;
  const files = [
    ...manifest.files,
    {
      path: "devkit.json",
      size: manifestBytes.length,
      sha256: sha(manifestBytes),
    },
  ];
  if (new Set(files.map((file) => file.path)).size !== files.length)
    throw new Error("Duplicate release file path");
  for (const file of files) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9.-]+$/.test(file.path))
      throw new Error("Invalid release file path");
    const source = path.join(directory, file.path);
    if (!promote) {
      const bytes = await fs.readFile(source);
      if (bytes.length !== file.size || sha(bytes) !== file.sha256)
        throw new Error(`Artifact changed: ${file.path}`);
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
          file.path.endsWith(".json")
            ? "application/json"
            : file.path.endsWith(".gz")
            ? "application/gzip"
            : file.path.endsWith(".sig")
            ? "application/octet-stream"
            : "text/plain; charset=utf-8",
          "--cache-control",
          "public,max-age=31536000,immutable",
          "--if-none-match",
          "*",
        ]);
      } catch (error) {
        if (
          !String(error.stderr || error.message).includes("PreconditionFailed")
        )
          throw error;
        const previous = path.join(directory, ".existing");
        command("aws", [
          "s3api",
          "get-object",
          "--bucket",
          bucket,
          "--key",
          prefix + file.path,
          previous,
        ]);
        if (sha(await fs.readFile(previous)) !== file.sha256)
          throw new Error(`Immutable DevKit file differs: ${file.path}`);
        await fs.unlink(previous);
      }
    }
    const response = await fetcher(`${BASE}/${manifest.version}/${file.path}`, {
      signal: AbortSignal.timeout(300000),
      cache: "no-store",
    });
    const publicBytes = Buffer.from(await response.arrayBuffer());
    if (
      !response.ok ||
      publicBytes.length !== file.size ||
      sha(publicBytes) !== file.sha256
    )
      throw new Error(`Public delivery verification failed: ${file.path}`);
  }
  if (!promote) return { uploaded: manifest.version };
  const indexFile = path.join(directory, ".index.json");
  let index = {
      schemaVersion: 1,
      kind: "meow.card.devkit.index",
      versions: [],
    },
    etag,
    previous;
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
    previous = await fs.readFile(indexFile);
    index = verifyEnvelope(previous, directory);
  } catch (error) {
    if (!/NoSuchKey|\(404\)/.test(String(error.stderr || error.message)))
      throw error;
  }
  const next = promoteIndex(index, {
    version: manifest.version,
    manifestSha256: sha(manifestBytes),
  });
  const signed =
    JSON.stringify(next) === JSON.stringify(index)
      ? previous
      : await signer(next, directory);
  await fs.writeFile(indexFile, signed);
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
  const response = await fetcher(`${BASE}/index.json`, {
    signal: AbortSignal.timeout(30000),
    cache: "no-store",
  });
  if (
    !response.ok ||
    sha(Buffer.from(await response.arrayBuffer())) !== sha(signed)
  )
    throw new Error("Published index delivery verification failed");
  await fs.unlink(indexFile);
  return next;
}
module.exports = {
  verifySource,
  prepare,
  publish,
  promoteIndex,
  decode,
  download,
  sha,
  config,
  BASE,
  run,
  exact,
  sign,
};
if (require.main === module) {
  const action = {
    "verify-source": verifySource,
    prepare,
    upload: publish,
    promote: (directory) => publish(directory, { promote: true }),
  }[process.argv[2]];
  if (!action)
    throw new Error("Expected verify-source, prepare, upload or promote");
  action(process.argv[3])
    .then((value) => console.log(JSON.stringify(value)))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
