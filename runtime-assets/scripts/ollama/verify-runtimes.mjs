#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { fail, loadLock, repoRoot, sha256File } from "./pack-runtimes.mjs";

const VERSION_RE = /^[0-9]+\.[0-9]+\.[0-9]+$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const SOURCE_URL_RE =
  /^https:\/\/github\.com\/ollama\/ollama\/releases\/download\/v[0-9.]+\/(ollama-linux-(amd64|arm64)\.tar\.zst|ollama-darwin\.tgz)$/;
const SOURCE_FILE_RE = /^(ollama-linux-(amd64|arm64)\.tar\.zst|ollama-darwin\.tgz)$/;
const PACK_ID_RE = /^(linux-(amd64|arm64)-(cpu|cuda)|darwin)$/;
const LICENSE_URL_RE = /^https:\/\/raw\.githubusercontent\.com\/ollama\/ollama\/v/;

function expectedPackFileName(packId) {
  if (packId === "darwin") {
    return "ollama-darwin.tgz";
  }
  return `ollama-${packId}.tar.zst`;
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function assert(condition, message) {
  if (!condition) {
    fail(message);
  }
}

export async function verifyRuntimes(root = repoRoot) {
  const lockPath = path.join(root, "ollama/runtimes.lock.json");
  const licensePath = path.join(root, "LICENSES/ollama-MIT.txt");
  const noticesPath = path.join(root, "ollama/NOTICES.md");
  await fs.access(licensePath);
  await fs.access(noticesPath);

  const lock = await loadLock(root);
  const licenseSha = await sha256File(licensePath);
  assert(licenseSha === lock.license.sha256, `license sha256 mismatch in ${lockPath}`);

  assert(lock.schemaVersion === "meow.runtime.ollama-runtimes.v1", "schemaVersion");
  assert(VERSION_RE.test(lock.engineVersion), "engineVersion");
  assert(lock.publicTag === `ollama-v${lock.engineVersion}`, "publicTag");
  assert(isNonEmptyString(lock.displayName), "displayName");
  assert(lock.upstreamRepository === "https://github.com/ollama/ollama", "upstreamRepository");
  assert(lock.upstreamTag === `v${lock.engineVersion}`, "upstreamTag");
  assert(LICENSE_URL_RE.test(lock.license.url), "license.url");
  assert(SHA256_RE.test(lock.license.sha256), "license.sha256");
  assert(lock.license.spdx === "MIT", "license.spdx");
  assert(lock.sources && typeof lock.sources === "object" && !Array.isArray(lock.sources), "sources");
  const sourceIds = Object.keys(lock.sources);
  assert(sourceIds.length > 0, "sources must not be empty");

  for (const source of Object.values(lock.sources)) {
    assert(SOURCE_URL_RE.test(source.url), `source url ${source.url}`);
    assert(SOURCE_FILE_RE.test(source.fileName), `source fileName ${source.fileName}`);
    assert(SHA256_RE.test(source.sha256), `source sha256 ${source.fileName}`);
    assert(Number.isInteger(source.sizeBytes) && source.sizeBytes > 0, `source size ${source.fileName}`);
  }

  assert(Array.isArray(lock.packs) && lock.packs.length > 0, "packs");
  const packIds = lock.packs.map((pack) => pack.id);
  const packFiles = lock.packs.map((pack) => pack.fileName);
  assert(new Set(packIds).size === packIds.length, "duplicate pack id");
  assert(new Set(packFiles).size === packFiles.length, "duplicate pack fileName");

  for (const pack of lock.packs) {
    assert(PACK_ID_RE.test(pack.id), `pack id ${pack.id}`);
    assert(pack.fileName === expectedPackFileName(pack.id), `pack fileName ${pack.id}`);
    assert(pack.source in lock.sources, `unknown source ${pack.source} for ${pack.id}`);
    assert(pack.transform === "identity" || pack.transform === "exclude", `transform ${pack.id}`);
    assert(Array.isArray(pack.require) && pack.require.length > 0, `require ${pack.id}`);
    assert(
      pack.require.every(
        (item) => item === "ollama" || item === "bin/ollama" || item.startsWith("lib/ollama/"),
      ),
      `require paths ${pack.id}`,
    );
    assert(
      (pack.forbid || []).every((item) => item.startsWith("lib/ollama/")),
      `forbid paths ${pack.id}`,
    );
    if (pack.transform === "exclude") {
      assert(Array.isArray(pack.exclude) && pack.exclude.length > 0, `exclude ${pack.id}`);
      assert(
        pack.exclude.every((item) => item === "lib/ollama/cuda_v12" || item === "lib/ollama/cuda_v13"),
        `exclude paths ${pack.id}`,
      );
    } else {
      assert(pack.exclude == null, `identity pack ${pack.id} must not set exclude`);
    }
  }
}

function invokedDirectly() {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  return pathToFileURL(path.resolve(entry)).href === import.meta.url;
}

if (invokedDirectly()) {
  verifyRuntimes().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
