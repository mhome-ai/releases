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
} = require("./developer-kit.cjs");
async function accept(kit, version, platform, directory) {
  exact(version);
  await fs.mkdir(directory, { recursive: true });
  const manifestBytes = await download(`${BASE}/${kit}/${version}/kit.json`);
  const manifest = decode(manifestBytes, directory);
  assert.equal(manifest.version, version);
  assert.equal(manifest.kit,kit);
  const acceptanceBytes = await download(`${BASE}/${kit}/${version}/acceptance.json`);
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
  const home = path.join(directory, "home");
  const env = { ...process.env, PATH: "" };
  delete env.NODE_PATH;
  delete env.NODE_OPTIONS;
  const call = (...args) =>
    JSON.parse(
      run(binary, ["--home", home, "make", "ui", "card", ...args], { env })
    );
  assert.equal(run(binary, ["--version"], { env }), `meow ${cli.version}`);
  const make=(...args)=>JSON.parse(run(binary,["--home",home,"make",...args],{env}));
  assert.equal(make("kit","status",kit).platform,platform);
  make("kit","install",kit,"--version",version);
  const runtime = manifest.platforms[platform];
  const nodeRoot = path.join(
    home,
    "tools/make/node",
    runtime.nodeVersion,
    platform,
    runtime.asset.sha256
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
  if(kit!=="ui") {
    await acceptDomain({kit,version,platform,directory,manifest,manifestBytes,home,node,env,make});
    make("kit","remove",kit,"--version",version);
    await fs.writeFile(path.join(directory,"result.json"),JSON.stringify({kit,version,platform,cliVersion:cli.version,manifestSha256:sha(manifestBytes),passed:true})+"\n");
    return;
  }
  for (const baseUi of ["default", "default-pod"]) {
    const project = path.join(directory, `skin-${baseUi}`);
    call("init", project, "--kit-version", version, "--base-ui", baseUi);
    call("deps", "install", project);
    const patterns = call("patterns", "--project", project);
    assert(patterns.patterns.length > 0);
    const out = path.join(directory, `dist-${baseUi}`);
    const built = call("build", project, out);
    assert.deepEqual(call("verify", out), built);
    assert.equal(built.baseUi, baseUi);
    const info = JSON.parse(
      await fs.readFile(path.join(out, "build-info.json"))
    );
    assert.equal(info.devkitVersion, version);
    assert.equal(info.devkitManifestSha256, sha(manifestBytes));
    const renderer = built.renderers[0];
    const preview = spawn(
      binary,
      [
        "--home",
        home,
        "make",
        "ui",
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
  }
  make("kit", "remove", kit,"--version",version);
  await fs.writeFile(
    path.join(directory, "result.json"),
    JSON.stringify(
      {
        version,
        platform,
        cliVersion: cli.version,
        manifestSha256: sha(manifestBytes),
        bases: ["default", "default-pod"],
        passed: true,
      },
      null,
      2
    ) + "\n"
  );
}
async function acceptDomain({kit,version,directory,manifest,manifestBytes,home,node,env,make}) {
  const project=path.join(directory,"project"),output=path.join(directory,"generated");
  await fs.mkdir(project);
  const installed=path.join(home,"tools/make/kits",kit,version,"kit");
  if(kit==="extension") {
    await fs.mkdir(path.join(project,"schema"));await fs.mkdir(path.join(project,"tests"));
    await fs.writeFile(path.join(project,"schema/test-device.yml"),"integration:\n  domain: test\n  entity: device\n");
    await fs.writeFile(path.join(project,"schema/test-device-state-value.yml"),"capability:\n  domain: test\n  entity: device\n  method: state\n  capability: value\n  implementation:\n    script: {name: double, args: [\"$req\"]}\n");
    await fs.writeFile(path.join(project,"extension.json"),JSON.stringify({schemaVersion:1,projectId:"test",integrations:[{id:"test.device",schemaRoot:"schema",scriptProject:".",tests:"tests"}]}));
    const source=JSON.parse(await fs.readFile(path.join(installed,"package.json")));
    await fs.writeFile(path.join(project,"package.json"),JSON.stringify({private:true,devDependencies:{"@mhome/script-build":source.dependencies["@mhome/script-build"]}}));
    await fs.writeFile(path.join(project,"double.ts"),"export default (n:number)=>n*2;");
    await fs.writeFile(path.join(project,"tests/behavior.test.mjs"),"import test from 'node:test';import assert from 'node:assert/strict';import {loadScript} from '@mhome/script-build/testing';test('behavior',async()=>assert.equal(await loadScript('double')([21]),42));");
    make("kit","use",kit,"--version",version,"--project",project);
    // The Kit manager owns Node/npm; authors keep ordinary exact dependencies.
    make("kit","deps",kit,"add","--project",project);
    make("extension","validate","--project",project);
    make("extension","test","--project",project,"--integration","test.device");
    const result=make("extension","build","--project",project,"--integration","test.device","--output",output);
    assert.equal(result.functions[0].function,"double");
    assert.equal((await fs.stat(path.join(output,"double.js"))).isFile(),true);
  } else {
    for(const [name,target] of [["contracts.fixture.json","wave.contracts.json"],["bindings.fixture.json","wave.bindings.json"]]) {
      const file=manifest.files.find(item=>item.path===name);assert(file);
      const bytes=await download(`${BASE}/${kit}/${version}/${name}`);
      assert.equal(bytes.length,file.size);assert.equal(sha(bytes),file.sha256);
      await fs.writeFile(path.join(project,target),bytes);
    }
    make("kit","use",kit,"--version",version,"--project",project);
    const script=`import {project,readJson} from ${JSON.stringify(require('node:url').pathToFileURL(path.join(installed,'src/contracts.mjs')).href)};import {generate} from ${JSON.stringify(require('node:url').pathToFileURL(path.join(installed,'src/generate.mjs')).href)};await generate(project(await readJson(process.argv[1]),await readJson(process.argv[2])),process.argv[3],JSON.parse(process.argv[4]));`;
    run(node,["--input-type=module","-e",script,path.join(project,"wave.contracts.json"),path.join(project,"wave.bindings.json"),output,JSON.stringify({kit,version,manifestSha256:sha(manifestBytes)})],{env});
    make("wave","check","--project",project,"--output",output);
    // This offline fixture validates the installed generator/checker, not live Hub access or SDK delivery.
  }
}
module.exports = { accept };
if (require.main === module)
  accept(...process.argv.slice(2)).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
