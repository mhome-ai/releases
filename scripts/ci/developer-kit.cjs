const fs = require("node:fs/promises");
const sync = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const config = require("./developer-kit-runtime.json");
const { assetUrl, releaseAssets } = require("./github-developer-release.cjs");
const BASE = "https://install.mhome.ai/devkits";
const METADATA = new Set(["kit.json", "acceptance.json", "node-SHASUMS256.txt", "node-SHASUMS256.txt.sig",
  "contracts.fixture.json", "bindings.fixture.json"]);
const UI_METADATA = new Set([
  "metadata.json",
  "index.d.ts",
  "react.d.ts",
  "default.d.ts",
  "default-pod.d.ts",
  "generated.d.ts",
  "skin-package.schema.json",
  "card-skins.schema.json",
  "README.md",
  "dependencies.json",
]);
const GITHUB_ASSET_MIN_CLI = "1.19.0";
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
const compareVersions = (a, b) => {
  const aa = a.split(".").map(Number),
    bb = b.split(".").map(Number);
  return aa[0] - bb[0] || aa[1] - bb[1] || aa[2] - bb[2];
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
      "MeowLink Developer Kit",
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
async function readExistingObject(directory, key, command = run) {
  if (!/^devkits\/(ui|extension|wave)\/(index\.json|\d+\.\d+\.\d+\/kit\.json)$/.test(key))
    throw new Error("Invalid publication state object");
  const file = path.join(directory, `.existing-${crypto.randomUUID()}`);
  try {
    // Public S3 origins legitimately return 403 for absent objects. Only the
    // authenticated object store decides whether a version already exists;
    // public delivery is checked separately after uploading the candidate.
    // A prefix-scoped ListBucket grant does not guarantee that GET/HEAD on a
    // missing key returns 404. Explicit listing establishes absence without
    // broadening the role or treating AccessDenied as a missing object.
    const listing = JSON.parse(command("aws", ["s3api", "list-objects-v2",
      "--bucket", "mhome-install-distribution", "--prefix", key, "--max-keys", "1",
      "--output", "json", "--cli-connect-timeout", "10", "--cli-read-timeout", "30"],
      {timeout: 45000}));
    const contents = listing.Contents ?? [];
    if (![0,1].includes(listing.KeyCount) || !Array.isArray(contents)
        || contents.length !== listing.KeyCount
        || contents.some(item => typeof item.Key !== "string" || !item.Key.startsWith(key)))
      throw new Error("Invalid publication state listing");
    // This general-purpose S3 bucket lists keys lexicographically. An exact key
    // precedes every longer key with the same prefix.
    if (!contents.some(item => item.Key === key)) return undefined;
    const object = JSON.parse(command("aws", ["s3api", "get-object", "--bucket", "mhome-install-distribution",
      "--key", key, "--output", "json",
      "--cli-connect-timeout", "10", "--cli-read-timeout", "30", file],
      {timeout: 45000}));
    if (typeof object.ETag !== "string" || !object.ETag) throw new Error("Missing object ETag");
    return {bytes: await fs.readFile(file), etag: object.ETag};
  } finally {
    await fs.rm(file, {force: true});
  }
}
async function readExistingManifest(directory, kit, version, command = run) {
  kitId(kit); exact(version);
  return (await readExistingObject(directory, `devkits/${kit}/${version}/kit.json`, command))?.bytes;
}
const SOURCE = {ui:{repository:"pallas-cat",manifest:"tools/card-devkit/package.json"},
  extension:{repository:"integration",manifest:"tools/devkit/package.json"},
  wave:{repository:"meow-wave",manifest:"tools/devkit/package.json"}};
function kitId(kit) { if (!Object.hasOwn(SOURCE,kit)) throw new Error("Unknown developer Kit"); return kit; }
async function verifySource(directory, { kit, tag, commit, command = run } = {}) {
  kitId(kit);
  const version = JSON.parse(
    await fs.readFile(
      path.join(directory, SOURCE[kit].manifest)
    )
  ).version;
  if (
    tag !== `kit-${kit}-v${exact(version)}` ||
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
    existingEnvelope,
    signer = sign,
    cliVersion, orchestratorCommit,
  } = {}
) {
  const built = JSON.parse(
    await fs.readFile(path.join(directory, "kit-build.json"))
  );
  kitId(built.kit);
  exact(built.version);
  exact(cliVersion);
  exact(built.minimumCliVersion);
  const minimumCliVersion = compareVersions(built.minimumCliVersion, GITHUB_ASSET_MIN_CLI) > 0
    ? built.minimumCliVersion : GITHUB_ASSET_MIN_CLI;
  if (compareVersions(cliVersion, minimumCliVersion) < 0)
    throw new Error(
      `Kit requires meow ${minimumCliVersion} or later; requested ${cliVersion}`
    );
  if (!built.source || !/^[a-f0-9]{40}$/.test(orchestratorCommit || ""))
    throw new Error("Missing frozen source provenance");
  const nodeBase = `https://nodejs.org/dist/v${config.nodeVersion}`;
  const sums = await downloadFile(`${nodeBase}/SHASUMS256.txt`);
  await fs.writeFile(path.join(directory, "node-SHASUMS256.txt"), sums);
  await fs.writeFile(
    path.join(directory, "node-SHASUMS256.txt.sig"),
    await downloadFile(`${nodeBase}/SHASUMS256.txt.sig`)
  );
  const nodeKeyring = path.join(directory, "node-signing-key.gpg");
  command("gpg", ["--batch", "--yes", "--dearmor", "--output", nodeKeyring,
    path.join(__dirname, "node-release-keys", `${config.nodeSigningKey}.asc`)]);
  command("gpgv", [
    "--keyring",
    nodeKeyring,
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
      path.join(__dirname, "developer-node-archive.py"),
      upstream,
      path.join(directory, output),
    ]);
    await fs.unlink(upstream);
    const [asset] = await inventory(directory, [output]);
    platforms[platform] = {
      nodeVersion: config.nodeVersion,
      npmVersion: config.npmVersion,
      minimumOs: pin.minimumOs,
      payload: (() => {
        const filename = built.payloads?.[platform] || "kit.tar.gz";
        const file = built.files.find(item => item.path === filename);
        if (!file) throw new Error(`Missing Kit payload: ${platform}`);
        return {url:assetUrl(built.source.tag, filename),size:file.size,sha256:file.sha256};
      })(),
      asset: {
        url: assetUrl(built.source.tag, output),
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
      client?.version !== cliVersion ||
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
  const manifest = {
    schemaVersion: 1,
    kind: "meow.developer-kit",
    kit: built.kit,
    version: built.version,
    workerProtocol: built.workerProtocol,
    minimumCliVersion,
    source: built.source,
    orchestratorCommit: orchestratorCommit,
    platforms,
    files,
  };
  const prior = existingEnvelope
    ? await existingEnvelope(`${BASE}/${built.kit}/${built.version}/kit.json`)
    : await readExistingManifest(directory, built.kit, built.version, command);
  const bytes = await signer(manifest, directory, prior);
  await fs.writeFile(path.join(directory, "kit.json"), bytes);
  return manifest;
}
function promoteIndex(index, entry) {
  if (
    index.schemaVersion !== 1 ||
    index.kind !== "meow.developer-kit.index" ||
    !Array.isArray(index.versions)
  )
    throw new Error("Invalid DevKit index");
  kitId(index.kit);
  [...index.versions, entry].forEach((item) => exact(item.version));
  const old = index.versions.find((item) => item.version === entry.version);
  if (old && JSON.stringify(old) !== JSON.stringify(entry))
    throw new Error("Published DevKit version changed");
  const versions = old ? [...index.versions] : [...index.versions, entry];
  versions.sort((a, b) => compareVersions(a.version, b.version));
  return {
    schemaVersion: 1,
    kind: "meow.developer-kit.index",
    kit:index.kit,
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
  const bucket = "mhome-install-distribution";
  const manifestBytes = await fs.readFile(path.join(directory, "kit.json"));
  const manifest = verifyEnvelope(manifestBytes, directory);
  kitId(manifest.kit);
  exact(manifest.version);
  if (
    manifest.schemaVersion !== 1 ||
    manifest.kind !== "meow.developer-kit" ||
    !manifest.files?.length
  )
    throw new Error("Invalid DevKit manifest");
  const prefix = `devkits/${manifest.kit}/${manifest.version}/`;
  const tag = `kit-${manifest.kit}-v${manifest.version}`;
  if (manifest.source?.tag !== tag || !/^[a-f0-9]{40}$/.test(manifest.source.commit)
      || !/^[a-f0-9]{40}$/.test(manifest.orchestratorCommit))
    throw new Error("Invalid DevKit release source");
  const files = [
    ...manifest.files,
    {
      path: "kit.json",
      size: manifestBytes.length,
      sha256: sha(manifestBytes),
    },
  ];
  if (new Set(files.map((file) => file.path)).size !== files.length)
    throw new Error("Duplicate release file path");
  const archives = new Map();
  const byName = new Map(files.map(file => [file.path, file]));
  for (const {asset, payload} of Object.values(manifest.platforms ?? {})) {
    for (const part of [asset, payload]) {
      const name = new URL(part.url).pathname.split("/").at(-1);
      const file = byName.get(name);
      if (!name.endsWith(".tar.gz") || part.url !== assetUrl(tag, name)
          || file?.sha256 !== part.sha256 || file?.size !== part.size)
        throw new Error("DevKit archive must match the signed GitHub Release inventory");
      archives.set(name, part.url);
    }
  }
  if (!archives.size || files.some(({path: name}) =>
    !archives.has(name) && !METADATA.has(name) &&
    !(manifest.kit === "ui" && UI_METADATA.has(name))))
    throw new Error("Invalid DevKit archive inventory");
  for (const file of files) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9.-]+$/.test(file.path))
      throw new Error("Invalid release file path");
    if (!promote) {
      const bytes = await fs.readFile(path.join(directory, file.path));
      if (bytes.length !== file.size || sha(bytes) !== file.sha256)
        throw new Error(`Artifact changed: ${file.path}`);
    }
  }
  if (!promote) {
    releaseAssets({
      tag, commit: manifest.orchestratorCommit, title: `MeowLink ${manifest.kit} Kit ${manifest.version}`,
      notes: `Source: ${manifest.source.tag} at ${manifest.source.commit}. The signed Kit index controls installer discovery.`,
      files: files.filter(file => archives.has(file.path)).map(file => ({...file,path:path.join(directory,file.path)})),
      publish: true,
    }, command);
  }
  async function verifyDelivery(file, url) {
    const response = await fetcher(url, { signal: AbortSignal.timeout(300000), cache: "no-store" });
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!response.ok || bytes.length !== file.size || sha(bytes) !== file.sha256)
      throw new Error(`Public delivery verification failed: ${file.path}`);
  }
  // Verify large assets before exposing their signed manifest.
  for (const [name, url] of archives) await verifyDelivery(byName.get(name), url);
  for (const file of files.filter(file => !archives.has(file.path))) {
    const source = path.join(directory, file.path);
    if (!promote) {
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
    await verifyDelivery(file, `${BASE}/${manifest.kit}/${manifest.version}/${file.path}`);
  }
  if (!promote) return { uploaded: manifest.version };
  const indexFile = path.join(directory, ".index.json");
  let index = {
      schemaVersion: 1,
      kind: "meow.developer-kit.index",
      kit:manifest.kit,
      versions: [],
    },
    etag,
    previous;
  const priorIndex = await readExistingObject(directory, `devkits/${manifest.kit}/index.json`, command);
  if (priorIndex) {
    etag = priorIndex.etag;
    previous = priorIndex.bytes;
    index = verifyEnvelope(previous, directory);
  }
  if(index.kit !== manifest.kit) throw new Error("Published index belongs to another Kit");
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
    `devkits/${manifest.kit}/index.json`,
    "--body",
    indexFile,
    "--content-type",
    "application/json",
    "--cache-control",
    "no-cache",
    ...(etag ? ["--if-match", etag] : ["--if-none-match", "*"]),
  ]);
  const response = await fetcher(`${BASE}/${manifest.kit}/index.json`, {
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
  SOURCE, kitId, verifySource,
  readExistingManifest, readExistingObject,
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
  const [action,directory,...args] = process.argv.slice(2);
  const execute = {
    "verify-source":() => verifySource(directory,{kit:args[0],tag:args[1],commit:args[2]}),
    prepare:() => prepare(directory,{cliVersion:args[0],orchestratorCommit:args[1]}),
    upload:() => publish(directory),
    promote:() => publish(directory,{promote:true}),
  }[action];
  if (!execute) throw new Error("Expected verify-source, prepare, upload or promote");
  execute().then(value=>console.log(JSON.stringify(value))).catch(error=>{console.error(error.message);process.exitCode=1;});
}
