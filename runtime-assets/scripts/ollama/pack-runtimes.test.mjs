#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  bumpRuntimes,
  listMembers,
  loadLock,
  packRuntimes,
  repoRoot,
  sha256File,
  writeTreeArchive,
} from "./pack-runtimes.mjs";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ollama-runtime-test."));
const fixtureRoot = path.join(tmp, "root");
const output = path.join(tmp, "out");
const sourceTree = path.join(tmp, "tree");
const sourceDir = path.join(tmp, "source");

try {
  await fs.mkdir(path.join(sourceTree, "bin"), { recursive: true });
  await fs.mkdir(path.join(sourceTree, "lib/ollama/cuda_v12"), { recursive: true });
  await fs.mkdir(path.join(sourceTree, "lib/ollama/cuda_v13"), { recursive: true });
  await fs.mkdir(path.join(sourceTree, "lib/ollama/vulkan"), { recursive: true });
  await fs.writeFile(path.join(sourceTree, "bin/ollama"), Buffer.from("ollama-bin"));
  await fs.writeFile(path.join(sourceTree, "lib/ollama/libggml.so"), Buffer.from("cpu"));
  await fs.writeFile(path.join(sourceTree, "lib/ollama/cuda_v12/libggml-cuda.so"), Buffer.from("cuda12"));
  await fs.writeFile(path.join(sourceTree, "lib/ollama/cuda_v13/libggml-cuda.so"), Buffer.from("cuda13"));
  await fs.writeFile(path.join(sourceTree, "lib/ollama/vulkan/libggml-vulkan.so"), Buffer.from("vk"));
  await fs.chmod(path.join(sourceTree, "bin/ollama"), 0o755);

  await fs.mkdir(sourceDir, { recursive: true });
  const archive = path.join(sourceDir, "ollama-linux-amd64.tar.zst");
  await writeTreeArchive(sourceTree, archive);
  const digest = await sha256File(archive);
  const size = (await fs.stat(archive)).size;
  const license = JSON.parse(
    await fs.readFile(path.join(repoRoot, "ollama/runtimes.lock.json"), "utf8"),
  ).license;

  const lock = {
    schemaVersion: "meow.runtime.ollama-runtimes.v1",
    engineVersion: "0.0.0",
    publicTag: "ollama-v0.0.0",
    displayName: "fixture",
    upstreamRepository: "https://github.com/ollama/ollama",
    upstreamTag: "v0.0.0",
    license,
    sources: {
      "linux-amd64": {
        url: "https://github.com/ollama/ollama/releases/download/v0.0.0/ollama-linux-amd64.tar.zst",
        fileName: "ollama-linux-amd64.tar.zst",
        sha256: digest,
        sizeBytes: size,
      },
    },
    packs: [
      {
        id: "linux-amd64-cpu",
        source: "linux-amd64",
        fileName: "ollama-linux-amd64-cpu.tar.zst",
        transform: "exclude",
        exclude: ["lib/ollama/cuda_v12", "lib/ollama/cuda_v13"],
        require: ["bin/ollama"],
        forbid: [
          "lib/ollama/cuda_v12",
          "lib/ollama/cuda_v13",
          "lib/ollama/rocm",
          "lib/ollama/mlx",
        ],
      },
      {
        id: "linux-amd64-cuda",
        source: "linux-amd64",
        fileName: "ollama-linux-amd64-cuda.tar.zst",
        transform: "identity",
        require: ["bin/ollama", "lib/ollama/cuda_v12", "lib/ollama/cuda_v13"],
        forbid: ["lib/ollama/rocm", "lib/ollama/mlx"],
      },
    ],
  };

  await fs.mkdir(path.join(fixtureRoot, "ollama/upstream"), { recursive: true });
  await fs.mkdir(path.join(fixtureRoot, "LICENSES"), { recursive: true });
  await fs.copyFile(
    path.join(repoRoot, "LICENSES/ollama-MIT.txt"),
    path.join(fixtureRoot, "LICENSES/ollama-MIT.txt"),
  );
  await fs.copyFile(
    path.join(repoRoot, "ollama/NOTICES.md"),
    path.join(fixtureRoot, "ollama/NOTICES.md"),
  );
  await fs.writeFile(
    path.join(fixtureRoot, "ollama/runtimes.lock.json"),
    `${JSON.stringify(lock, null, 2)}\n`,
  );
  await fs.copyFile(archive, path.join(fixtureRoot, "ollama/upstream", path.basename(archive)));

  await packRuntimes(fixtureRoot, output, undefined);

  const cpu = path.join(output, "ollama-linux-amd64-cpu.tar.zst");
  const cuda = path.join(output, "ollama-linux-amd64-cuda.tar.zst");
  const cpuNames = listMembers(cpu);
  const cudaNames = listMembers(cuda);

  assert.ok(cpuNames.some((name) => name === "bin/ollama" || name.endsWith("bin/ollama")), cpuNames);
  assert.ok(cpuNames.some((name) => name.includes("vulkan")), cpuNames);
  assert.equal(cpuNames.some((name) => name.includes("cuda_v")), false, cpuNames);
  assert.equal(await sha256File(cuda), digest);
  assert.ok(cudaNames.some((name) => name.includes("cuda_v12")));
  assert.ok(cudaNames.some((name) => name.includes("cuda_v13")));
  await fs.access(path.join(output, "LICENSE"));
  await fs.access(path.join(output, "SHA256SUMS"));
  console.log("ok pack");

  await fs.writeFile(path.join(fixtureRoot, "ollama/upstream/ollama-linux-arm64.tar.zst"), await fs.readFile(archive));
  await fs.writeFile(path.join(fixtureRoot, "ollama/upstream/ollama-darwin.tgz"), await fs.readFile(archive));
  lock.sources["linux-arm64"] = {
    url: "https://github.com/ollama/ollama/releases/download/v0.0.0/ollama-linux-arm64.tar.zst",
    fileName: "ollama-linux-arm64.tar.zst",
    sha256: digest,
    sizeBytes: size,
  };
  lock.sources.darwin = {
    url: "https://github.com/ollama/ollama/releases/download/v0.0.0/ollama-darwin.tgz",
    fileName: "ollama-darwin.tgz",
    sha256: digest,
    sizeBytes: size,
  };
  await fs.writeFile(
    path.join(fixtureRoot, "ollama/runtimes.lock.json"),
    `${JSON.stringify(lock, null, 2)}\n`,
  );
  await bumpRuntimes(fixtureRoot, "1.2.3", {
    licenseFile: path.join(fixtureRoot, "LICENSES/ollama-MIT.txt"),
    checksums: {
      "ollama-linux-amd64.tar.zst": digest,
      "ollama-linux-arm64.tar.zst": digest,
      "ollama-darwin.tgz": digest,
    },
    sizes: {
      "ollama-linux-amd64.tar.zst": size,
      "ollama-linux-arm64.tar.zst": size,
      "ollama-darwin.tgz": size,
    },
  });
  const bumped = await loadLock(fixtureRoot);
  assert.equal(bumped.engineVersion, "1.2.3");
  assert.equal(bumped.publicTag, "ollama-v1.2.3");
  assert.equal(bumped.upstreamTag, "v1.2.3");
  assert.ok(bumped.sources["linux-amd64"].url.endsWith("/v1.2.3/ollama-linux-amd64.tar.zst"));
  assert.ok(bumped.sources.darwin.url.endsWith("/v1.2.3/ollama-darwin.tgz"));
  assert.equal(bumped.sources["linux-amd64"].sha256, digest);
  assert.deepEqual(bumped.packs[0].exclude, ["lib/ollama/cuda_v12", "lib/ollama/cuda_v13"]);
  console.log("ok bump");
} finally {
  await fs.rm(tmp, { recursive: true, force: true });
}
