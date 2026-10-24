const fs = require("node:fs/promises");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { once } = require("node:events");
const assert = require("node:assert/strict");
const {
  decode,
  download,
  sha,
  BASE,
  run,
  exact,
} = require("./card-devkit.cjs");
async function accept(version, platform, directory) {
  exact(version);
  await fs.mkdir(directory, { recursive: true });
  const manifestBytes = await download(`${BASE}/${version}/devkit.json`);
  const manifest = decode(manifestBytes, directory);
  assert.equal(manifest.version, version);
  const acceptanceBytes = await download(`${BASE}/${version}/acceptance.json`);
  const file = manifest.files.find((item) => item.path === "acceptance.json");
  assert.equal(sha(acceptanceBytes), file.sha256);
  assert.equal(acceptanceBytes.length, file.size);
  const cli = JSON.parse(acceptanceBytes)[platform];
  assert(cli);
  const bytes = await download(cli.asset.url);
  assert.equal(sha(bytes), cli.asset.sha256);
  assert.equal(bytes.length, cli.asset.size);
  const archive = path.join(
    directory,
    new URL(cli.asset.url).pathname.split("/").at(-1)
  );
  await fs.writeFile(archive, bytes);
  const extracted = path.join(directory, "cli");
  await fs.mkdir(extracted);
  // Native release packages already use tar archives; their signatures and hashes were frozen in acceptance.json.
  run("tar", ["-xf", archive, "-C", extracted]);
  const binary = path.join(
    extracted,
    "bin",
    platform === "win-x64" ? "meow.exe" : "meow"
  );
  assert(
    (await fs.stat(binary)).isFile(),
    "Native Client package must contain its standard CLI entrypoint"
  );
  const home = path.join(directory, "home"),
    project = path.join(directory, "skin");
  const env = { ...process.env, PATH: "" };
  delete env.NODE_PATH;
  delete env.NODE_OPTIONS;
  const call = (...args) =>
    JSON.parse(
      run(binary, ["--home", home, "customize", "card", ...args], { env })
    );
  assert.equal(run(binary, ["--version"], { env }), `meow ${cli.version}`);
  assert.equal(call("toolchain", "status").platform, platform);
  call("toolchain", "install", "--version", version);
  const runtime = manifest.platforms[platform];
  const nodeRoot = path.join(
    home,
    "tools/customize/node",
    runtime.nodeVersion,
    platform
  );
  const windows = platform === "win-x64";
  const node = path.join(nodeRoot, windows ? "node.exe" : "bin/node");
  const identity = JSON.parse(
    run(
      node,
      [
        "-p",
        "JSON.stringify({version:process.versions.node,arch:process.arch})",
      ],
      { env }
    )
  );
  assert.equal(identity.version, runtime.nodeVersion);
  assert.equal(identity.arch, platform.endsWith("arm64") ? "arm64" : "x64");
  const npm = JSON.parse(
    await fs.readFile(
      path.join(
        nodeRoot,
        windows
          ? "node_modules/npm/package.json"
          : "lib/node_modules/npm/package.json"
      )
    )
  );
  assert.equal(npm.version, runtime.npmVersion);
  call("init", project, "--devkit", version);
  call("deps", "install", project);
  const patterns = call("patterns", "--project", project);
  assert(patterns.patterns.length > 0);
  const out = path.join(directory, "dist");
  const built = call("build", project, out);
  assert.deepEqual(call("verify", out), built);
  const info = JSON.parse(await fs.readFile(path.join(out, "build-info.json")));
  assert.equal(info.devkitVersion, version);
  assert.equal(info.devkitManifestSha256, sha(manifestBytes));
  const renderer = built.renderers[0];
  const preview = spawn(
    binary,
    [
      "--home",
      home,
      "customize",
      "card",
      "preview",
      "start",
      project,
      "--pattern",
      renderer.supportedPatterns[0].patternId,
      "--renderer",
      renderer.id,
    ],
    {
      env,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "inherit"],
    }
  );
  let stdout = "";
  try {
    const url = await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Preview startup timed out")),
        60000
      );
      preview.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      preview.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`Preview exited: ${code}`));
      });
      preview.stdout.on("data", (chunk) => {
        stdout += chunk;
        if (stdout.includes("\n")) {
          clearTimeout(timer);
          try {
            resolve(JSON.parse(stdout.split("\n")[0]).url);
          } catch (error) {
            reject(error);
          }
        }
      });
    });
    const before = call("preview", "status", "--url", url);
    assert.equal(before.status, "ready");
    await fs.appendFile(
      path.join(project, "skin.jsx"),
      "\n// acceptance save\n"
    );
    let updated;
    for (let attempt = 0; attempt < 100; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      updated = call("preview", "status", "--url", url);
      if (updated.status === "ready" && updated.build.id !== before.build.id)
        break;
    }
    assert.equal(updated.status, "ready");
    assert.notEqual(
      updated.build.id,
      before.build.id,
      "File watcher must publish a fresh build"
    );
    const exited = once(preview, "exit", {
      signal: AbortSignal.timeout(15000),
    });
    call("preview", "stop", "--url", url);
    await exited;
  } finally {
    if (preview.exitCode === null) {
      if (process.platform === "win32")
        spawnSync("taskkill", ["/PID", String(preview.pid), "/T", "/F"], {
          stdio: "ignore",
        });
      else {
        try {
          process.kill(-preview.pid, "SIGTERM");
        } catch (error) {
          if (error.code !== "ESRCH") throw error;
        }
      }
    }
  }
  call("toolchain", "remove", "--version", version);
  await fs.writeFile(
    path.join(directory, "result.json"),
    JSON.stringify(
      {
        version,
        platform,
        cliVersion: cli.version,
        manifestSha256: sha(manifestBytes),
        passed: true,
      },
      null,
      2
    ) + "\n"
  );
}
module.exports = { accept };
if (require.main === module)
  accept(...process.argv.slice(2)).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
