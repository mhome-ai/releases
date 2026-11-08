const fs = require("node:fs/promises");
const path = require("node:path");
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
  await acceptUiProjects({directory,version,manifestBytes,call});
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
// This is the offline toolchain gate. Desktop Preview uses a signed-in App,
// active Space and the native host boundary; it has no standalone web server.
async function acceptUiProjects({directory,version,manifestBytes,call}) {
  for (const baseUi of ["default", "default-pod"]) {
    const project=path.join(directory,`skin-${baseUi}`);
    await call("init",project,"--kit-version",version,"--base-ui",baseUi);
    await call("deps","install",project);
    const patterns=await call("patterns","--project",project);
    assert(patterns.patterns.length>0);
    const out=path.join(directory,`dist-${baseUi}`);
    const built=await call("build",project,out);
    assert.deepEqual(await call("verify",out),built);
    assert.equal(built.baseUi,baseUi);
    const info=JSON.parse(await fs.readFile(path.join(out,"build-info.json")));
    assert.equal(info.devkitVersion,version);
    assert.equal(info.devkitManifestSha256,sha(manifestBytes));
    const entry=path.join(out,built.entry),original=await fs.readFile(entry);
    try {
      await fs.appendFile(entry,"\n// altered release bytes\n");
      await assert.rejects(async()=>call("verify",out),undefined,
        "Verification must reject altered compiled bytes");
    } finally {await fs.writeFile(entry,original);}
    await fs.appendFile(path.join(project,"surface.css"),"\n:root { --acceptance-rebuild: 1; }\n");
    const rebuilt=await call("build",project,`${out}-next`);
    assert.notDeepEqual(rebuilt.files,built.files,"Rebuilding an edited source must change its artifacts");
    assert.deepEqual(await call("verify",out),built,"A rebuild must preserve the previous verified output");
  }
}
async function acceptDomain({kit,version,directory,manifest,manifestBytes,home,node,env,make}) {
  const project=path.join(directory,"project"),output=path.join(directory,"generated");
  await fs.mkdir(project);
  const installed=path.join(home,"tools/make/kits",kit,version,"kit");
  if(kit==="extension") {
    await fs.mkdir(path.join(project,"schema"));await fs.mkdir(path.join(project,"tests"));
    await fs.writeFile(path.join(project,"schema/test-device.yml"),"integration:\n  domain: test\n  entity: device\n");
    await fs.writeFile(path.join(project,"schema/test-device-state-value.yml"),"capability:\n  domain: test\n  entity: device\n  method: state\n  capability: value\n  implementation:\n    script: {name: double, args: [\"$req\"]}\n");
    await fs.writeFile(path.join(project,"extension.json"),JSON.stringify({schemaVersion:1,projectId:"test",ui:"ui",integrations:[{id:"test.device",schemaRoot:"schema",scriptProject:".",tests:"tests"}]}));
    await fs.mkdir(path.join(project,"ui"));
    await fs.writeFile(path.join(project,"ui/package.json"),JSON.stringify({private:true,scripts:{"build:extension":"node build.cjs"}}));
    await fs.writeFile(path.join(project,"ui/build.cjs"),"const fs=require('node:fs'),path=require('node:path');fs.writeFileSync(path.join(process.argv[process.argv.indexOf('--output')+1],'index.js'),'export const ready=true;');");
    const source=JSON.parse(await fs.readFile(path.join(installed,"package.json")));
    await fs.writeFile(path.join(project,"package.json"),JSON.stringify({private:true,devDependencies:{"@mhome/script-build":source.dependencies["@mhome/script-build"]}}));
    await fs.writeFile(path.join(project,"double.ts"),"export default (n:number)=>n*2;");
    await fs.writeFile(path.join(project,"tests/behavior.test.mjs"),"import test from 'node:test';import assert from 'node:assert/strict';import {loadScript} from '@mhome/script-build/testing';test('behavior',async()=>assert.equal(await loadScript('double')([21]),42));");
    make("kit","use",kit,"--version",version,"--project",project);
    // The Kit manager owns Node/npm; authors keep ordinary exact dependencies.
    make("kit","deps",kit,"add","--project",project);
    make("kit","deps",kit,"add","--project",project,"--directory","ui");
    make("extension","validate","--project",project);
    make("extension","test","--project",project,"--integration","test.device");
    const result=make("extension","build","--project",project,"--integration","test.device","--output",output);
    assert.equal(result.functions[0].function,"double");
    assert.equal((await fs.stat(path.join(output,"double.js"))).isFile(),true);
    const uiOutput=`${output}-ui`;
    const uiResult=make("extension","ui-build","--project",project,"--output",uiOutput);
    assert(uiResult.files.some(file=>file.path==="index.js"));
    assert.equal(await fs.readFile(path.join(uiOutput,"index.js"),"utf8"),"export const ready=true;");
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
module.exports = { accept, acceptUiProjects };
if (require.main === module)
  accept(...process.argv.slice(2)).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
