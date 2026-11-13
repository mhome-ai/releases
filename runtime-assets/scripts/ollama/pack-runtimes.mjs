#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const VERSION_RE = /^[0-9]+\.[0-9]+\.[0-9]+$/;
const SOURCE_FILES = {
  "linux-amd64": "ollama-linux-amd64.tar.zst",
  "linux-arm64": "ollama-linux-arm64.tar.zst",
  darwin: "ollama-darwin.tgz",
};
const SKIP_NAMES = new Set([".DS_Store"]);
const GNU_MAGIC = Buffer.from("ustar ");
const GNU_VERSION = Buffer.from(" \0");

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export function fail(message) {
  throw new Error(message);
}

export async function loadLock(root) {
  return JSON.parse(await fs.readFile(path.join(root, "ollama/runtimes.lock.json"), "utf8"));
}

export async function sha256File(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

export function memberMatches(member, prefix) {
  const trimmed = prefix.replace(/\/+$/, "");
  return member === trimmed || member.startsWith(`${trimmed}/`);
}

function toPosix(relativePath) {
  return relativePath.split(path.sep).join("/");
}

function shouldSkip(name) {
  return SKIP_NAMES.has(name) || name.startsWith("._");
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    ...options,
  });
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    fail(`${command} ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`);
  }
  return result;
}

function tarListArgs(archive) {
  if (archive.endsWith(".tgz") || archive.endsWith(".tar.gz")) {
    return ["-tzf", archive];
  }
  if (archive.endsWith(".tar.zst")) {
    return ["--zstd", "-tf", archive];
  }
  fail(`unsupported archive ${archive}`);
}

export function listMembers(archive) {
  const result = run("tar", tarListArgs(archive), { stdio: ["ignore", "pipe", "pipe"] });
  return result.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((name) => name.replace(/^\.\//, ""));
}

export async function assertLayout(archive, require = [], forbid = []) {
  const names = listMembers(archive);
  for (const needed of require) {
    if (!names.some((name) => memberMatches(name, needed))) {
      fail(`${path.basename(archive)} is missing required path ${needed}`);
    }
  }
  for (const blocked of forbid) {
    const hit = names.find((name) => memberMatches(name, blocked));
    if (hit) {
      fail(`${path.basename(archive)} contains forbidden path ${blocked}: ${hit}`);
    }
  }
}

export function upstreamDir(root) {
  return path.join(root, "ollama/upstream");
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchBuffer(url) {
  let lastError;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const response = await fetch(url, { redirect: "follow" });
      if (!response.ok) {
        throw new Error(`${url}: HTTP ${response.status}`);
      }
      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      lastError = error;
      await sleep(2000);
    }
  }
  throw lastError;
}

async function fetchContentLength(url) {
  const response = await fetch(url, { method: "HEAD", redirect: "follow" });
  if (!response.ok) {
    fail(`could not read Content-Length for ${url}`);
  }
  const length = Number(response.headers.get("content-length"));
  if (!Number.isInteger(length) || length <= 0) {
    fail(`could not read Content-Length for ${url}`);
  }
  return length;
}

async function download(url, dest) {
  await fs.mkdir(path.dirname(dest), { recursive: true });
  const partial = `${dest}.partial`;
  await fs.rm(partial, { force: true });
  let lastError;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const response = await fetch(url, { redirect: "follow" });
      if (!response.ok) {
        throw new Error(`${url}: HTTP ${response.status}`);
      }
      if (!response.body) {
        throw new Error(`${url}: empty body`);
      }
      await pipeline(Readable.fromWeb(response.body), createWriteStream(partial));
      await fs.rename(partial, dest);
      return;
    } catch (error) {
      lastError = error;
      await fs.rm(partial, { force: true });
      await sleep(2000);
    }
  }
  throw lastError;
}

async function cacheMatches(file, sha256, sizeBytes) {
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size !== sizeBytes) {
      return false;
    }
  } catch (error) {
    if (error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
  return (await sha256File(file)) === sha256;
}

export async function ensureSource(source, cacheDir) {
  const fileName = source.fileName;
  const dest = path.join(cacheDir, fileName);
  if (await cacheMatches(dest, source.sha256, source.sizeBytes)) {
    console.error(`using cached ${fileName}`);
    return dest;
  }
  try {
    await fs.access(dest);
    console.error(`replacing mismatched ${fileName}`);
    await fs.unlink(dest);
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
  console.error(`downloading ${fileName}`);
  await download(source.url, dest);
  if (!(await cacheMatches(dest, source.sha256, source.sizeBytes))) {
    await fs.rm(dest, { force: true });
    fail(`${fileName} did not match pinned sha256 or size after download`);
  }
  return dest;
}

async function extractExcluding(archive, dest, exclude) {
  await fs.rm(dest, { recursive: true, force: true });
  await fs.mkdir(dest, { recursive: true });
  const args = ["--zstd", "-xf", archive, "-C", dest];
  for (const prefix of exclude) {
    args.push("--exclude", prefix);
  }
  run("tar", args, {
    stdio: "inherit",
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
  for (const prefix of exclude) {
    await fs.rm(path.join(dest, ...prefix.split("/")), { recursive: true, force: true });
  }
}

function writeString(buf, offset, max, value) {
  buf.fill(0, offset, offset + max);
  Buffer.from(String(value), "utf8").copy(buf, offset, 0, max);
}

function writeOctal(buf, offset, size, value) {
  buf.write(`${value.toString(8).padStart(size - 1, "0")}\0`, offset, size, "ascii");
}

function gnuHeader({ name, mode, size, typeflag, linkname = "" }) {
  const buf = Buffer.alloc(512);
  writeString(buf, 0, 100, name);
  writeOctal(buf, 100, 8, mode);
  writeOctal(buf, 108, 8, 0);
  writeOctal(buf, 116, 8, 0);
  writeOctal(buf, 124, 12, size);
  writeOctal(buf, 136, 12, 0);
  buf.fill(0x20, 148, 156);
  buf.write(typeflag, 156, 1, "ascii");
  writeString(buf, 157, 100, linkname);
  GNU_MAGIC.copy(buf, 257);
  GNU_VERSION.copy(buf, 263);
  writeString(buf, 265, 32, "root");
  writeString(buf, 297, 32, "root");
  let sum = 0;
  for (const byte of buf) {
    sum += byte;
  }
  buf.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return buf;
}

function pad512(data) {
  const padded = Math.ceil(data.length / 512) * 512;
  if (padded === data.length) {
    return data;
  }
  return Buffer.concat([data, Buffer.alloc(padded - data.length)]);
}

function* gnuLongLink(name, typeflag) {
  const payload = Buffer.from(`${name}\0`, "utf8");
  yield gnuHeader({
    name: "././@LongLink",
    mode: 0o644,
    size: payload.length,
    typeflag,
  });
  yield pad512(payload);
}

async function collectTree(root) {
  const entries = [];
  async function walk(dir) {
    const names = (await fs.readdir(dir, { withFileTypes: true }))
      .filter((entry) => !shouldSkip(entry.name))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of names) {
      const abs = path.join(dir, entry.name);
      entries.push(abs);
      const stat = await fs.lstat(abs);
      if (stat.isDirectory()) {
        await walk(abs);
      }
    }
  }
  await walk(root);
  entries.sort((a, b) => {
    const left = toPosix(path.relative(root, a));
    const right = toPosix(path.relative(root, b));
    return left < right ? -1 : left > right ? 1 : 0;
  });
  return entries;
}

async function* tarStream(tree) {
  for (const abs of await collectTree(tree)) {
    const rel = toPosix(path.relative(tree, abs));
    const stat = await fs.lstat(abs);
    if (rel.length >= 100) {
      yield* gnuLongLink(rel, "L");
    }
    if (stat.isSymbolicLink()) {
      const linkname = await fs.readlink(abs);
      if (linkname.length >= 100) {
        yield* gnuLongLink(linkname, "K");
      }
      yield gnuHeader({
        name: rel.slice(0, 100),
        mode: 0o777,
        size: 0,
        typeflag: "2",
        linkname: linkname.slice(0, 100),
      });
      continue;
    }
    if (stat.isDirectory()) {
      yield gnuHeader({
        name: rel.slice(0, 100),
        mode: 0o755,
        size: 0,
        typeflag: "5",
      });
      continue;
    }
    const mode = stat.mode & 0o111 ? 0o755 : 0o644;
    yield gnuHeader({
      name: rel.slice(0, 100),
      mode,
      size: stat.size,
      typeflag: "0",
    });
    const handle = await fs.open(abs, "r");
    try {
      const buf = Buffer.alloc(1024 * 1024);
      let remaining = stat.size;
      while (remaining > 0) {
        const { bytesRead } = await handle.read(buf, 0, Math.min(buf.length, remaining));
        if (bytesRead === 0) {
          fail(`short read while packing ${rel}`);
        }
        yield Buffer.from(buf.subarray(0, bytesRead));
        remaining -= bytesRead;
      }
    } finally {
      await handle.close();
    }
    const pad = (512 - (stat.size % 512)) % 512;
    if (pad) {
      yield Buffer.alloc(pad);
    }
  }
  yield Buffer.alloc(1024);
}

export async function writeTreeArchive(tree, dest) {
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.rm(dest, { force: true });
  const zstd = spawn("zstd", ["-q", "-T0", "-19", "-f", "-o", dest], {
    stdio: ["pipe", "inherit", "inherit"],
  });
  const closed = new Promise((resolve, reject) => {
    zstd.on("error", reject);
    zstd.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`zstd failed writing ${dest}`));
      }
    });
  });
  await pipeline(Readable.from(tarStream(tree)), zstd.stdin);
  await closed;
}

async function writeNotices(root, dest) {
  const notices = [
    await fs.readFile(path.join(root, "ollama/NOTICES.md"), "utf8"),
    "===== OLLAMA MIT LICENSE =====\n",
    await fs.readFile(path.join(root, "LICENSES/ollama-MIT.txt"), "utf8"),
  ];
  await fs.writeFile(path.join(dest, "OLLAMA_NOTICES.txt"), `${notices.join("\n").trimEnd()}\n`);
  await fs.copyFile(path.join(root, "LICENSES/ollama-MIT.txt"), path.join(dest, "LICENSE"));
  await fs.copyFile(
    path.join(root, "ollama/runtimes.lock.json"),
    path.join(dest, "OLLAMA_SOURCE.json"),
  );
}

async function packOne(pack, sourcePath, output, workDir) {
  const dest = path.join(output, pack.fileName);
  if (pack.transform === "identity") {
    await fs.rm(dest, { force: true });
    try {
      await fs.link(sourcePath, dest);
    } catch {
      await fs.copyFile(sourcePath, dest);
    }
  } else if (pack.transform === "exclude") {
    const tree = path.join(workDir, pack.id);
    await extractExcluding(sourcePath, tree, pack.exclude || []);
    await writeTreeArchive(tree, dest);
    await fs.rm(tree, { recursive: true, force: true });
  } else {
    fail(`unsupported transform ${pack.transform} for ${pack.id}`);
  }
  await assertLayout(dest, pack.require || [], pack.forbid || []);
  return dest;
}

function selectedPacks(lock, packId) {
  if (!packId) {
    return lock.packs;
  }
  const matches = lock.packs.filter((pack) => pack.id === packId);
  if (matches.length === 0) {
    fail(`unknown pack id ${packId}`);
  }
  return matches;
}

export function parseSha256Sum(text) {
  const mapping = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const parts = line.split(/\s+/);
    if (parts.length < 2) {
      fail(`invalid sha256sum line: ${line}`);
    }
    mapping[parts[parts.length - 1].replace(/^\*/, "")] = parts[0].toLowerCase();
  }
  return mapping;
}

function officialUrl(version, fileName) {
  return `https://github.com/ollama/ollama/releases/download/v${version}/${fileName}`;
}

export async function bumpRuntimes(root, version, options = {}) {
  if (!VERSION_RE.test(version)) {
    fail(`version must be X.Y.Z, got ${version}`);
  }
  const lock = await loadLock(root);
  lock.engineVersion = version;
  lock.publicTag = `ollama-v${version}`;
  lock.displayName = `Ollama runtimes ${version}`;
  lock.upstreamTag = `v${version}`;
  lock.license.url = `https://raw.githubusercontent.com/ollama/ollama/v${version}/LICENSE`;

  let licenseBytes = options.licenseFile
    ? await fs.readFile(options.licenseFile)
    : await fetchBuffer(lock.license.url);
  let licenseText = licenseBytes.toString("utf8");
  if (!licenseText.endsWith("\n")) {
    licenseText += "\n";
    licenseBytes = Buffer.from(licenseText, "utf8");
  }
  await fs.writeFile(path.join(root, "LICENSES/ollama-MIT.txt"), licenseBytes);
  lock.license.sha256 = createHash("sha256").update(licenseBytes).digest("hex");

  const checksums =
    options.checksums ?? parseSha256Sum((await fetchBuffer(officialUrl(version, "sha256sum.txt"))).toString("utf8"));

  for (const [sourceId, fileName] of Object.entries(SOURCE_FILES)) {
    const source = lock.sources[sourceId];
    source.url = officialUrl(version, fileName);
    source.fileName = fileName;
    if (!(fileName in checksums)) {
      fail(`${fileName} is not in upstream sha256sum.txt`);
    }
    source.sha256 = checksums[fileName];
    source.sizeBytes =
      options.sizes && fileName in options.sizes
        ? options.sizes[fileName]
        : await fetchContentLength(source.url);
  }

  const lockPath = path.join(root, "ollama/runtimes.lock.json");
  await fs.writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  console.error(`pinned Ollama ${version} -> ${lockPath}`);
}

export async function packRuntimes(root, output, packId) {
  const lock = await loadLock(root);
  let outputExists = false;
  try {
    await fs.access(output);
    outputExists = true;
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
  if (outputExists) {
    fail(`output path already exists: ${output}`);
  }
  await fs.mkdir(output, { recursive: true });
  const workDir = path.join(output, ".work");
  await fs.mkdir(workDir, { recursive: true });
  const cacheDir = upstreamDir(root);
  await fs.mkdir(cacheDir, { recursive: true });

  const packs = selectedPacks(lock, packId);
  const sourceIds = [...new Set(packs.map((pack) => pack.source))].sort();
  const sources = {};
  for (const sourceId of sourceIds) {
    sources[sourceId] = await ensureSource(lock.sources[sourceId], cacheDir);
  }
  for (const pack of packs) {
    console.error(`packing ${pack.id}`);
    await packOne(pack, sources[pack.source], output, workDir);
  }
  await writeNotices(root, output);
  await fs.rm(workDir, { recursive: true, force: true });

  const files = (await fs.readdir(output, { withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
  const checksumLines = [];
  for (const name of files) {
    checksumLines.push(`${await sha256File(path.join(output, name))}  ${name}\n`);
  }
  await fs.writeFile(path.join(output, "SHA256SUMS"), checksumLines.join(""));
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--root") {
      args.root = argv[(i += 1)];
    } else if (token === "--output") {
      args.output = argv[(i += 1)];
    } else if (token === "--pack") {
      args.pack = argv[(i += 1)];
    } else if (token === "--license-file") {
      args.licenseFile = argv[(i += 1)];
    } else if (token.startsWith("-")) {
      fail(`unknown flag ${token}`);
    } else {
      args._.push(token);
    }
  }
  return args;
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const command = args._.shift();
  const root = path.resolve(args.root || repoRoot);
  if (command === "pack") {
    const output = args.output || args._[0];
    if (!output) {
      fail("usage: pack-runtimes.mjs pack <output-dir> [pack-id]");
    }
    await packRuntimes(root, path.resolve(output), args.pack || args._[1]);
    return;
  }
  if (command === "bump") {
    const version = args._[0];
    if (!version) {
      fail("usage: pack-runtimes.mjs bump <x.y.z>");
    }
    await bumpRuntimes(root, version, {
      licenseFile: args.licenseFile ? path.resolve(args.licenseFile) : undefined,
    });
    return;
  }
  fail("usage: pack-runtimes.mjs <pack|bump> ...");
}

function invokedDirectly() {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  return path.resolve(entry) === fileURLToPath(import.meta.url);
}

if (invokedDirectly()) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
