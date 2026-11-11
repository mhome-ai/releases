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
async function isolatedSystemTools(directory) {
  const tools = path.join(directory, "system-tools");
  await fs.mkdir(tools);
  // npm run requires the OS shell. Advertised Mac/Linux platforms retain that
  // real tool, while Node/npm must still come from the installed Kit.
  await fs.symlink("/bin/sh", path.join(tools, "sh"));
  return tools;
}
// These documented commands must work without a signed-in App or daemon.
function assertUiPreviewCommands(help) {
  const commands = {
    inspect: ["space", "card"],
    apply: ["space", "base-ui", "card", "pattern", "renderer", "config"],
    status: ["space", "base-ui"],
    stop: ["space", "base-ui", "card", "pattern"],
  };
  for (const [command, options] of Object.entries(commands)) {
    const output = help("preview", command, "--help");
    for (const option of options)
      assert.match(
        output,
        new RegExp(`(?:^|\\s)--${option}(?=[=\\s]|$)`),
        `meow make ui card preview ${command} must support --${option}`
      );
  }
}
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
  const env = { ...process.env, PATH: await isolatedSystemTools(directory) };
  delete env.NODE_PATH;
  delete env.NODE_OPTIONS;
  const call = (...args) =>
    JSON.parse(
      run(binary, ["--home", home, "make", "ui", "card", ...args], { env })
    );
  assert.equal(run(binary, ["--version"], { env }), `meow ${cli.version}`);
  if (kit === "ui")
    assertUiPreviewCommands((...args) =>
      run(binary, ["--home", home, "make", "ui", "card", ...args], { env })
    );
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
  const installed=path.join(home,"tools/make/kits",kit,version,"kit");
  if(kit==="extension") {
    make("extension","init",project,"--kit-version",version,"--integration","test.device");
    const pin=JSON.parse(await fs.readFile(path.join(project,"meow.make.json")));
    assert.equal(pin.kits.extension.version,version);
    const lock=JSON.parse(await fs.readFile(path.join(project,"ts/package-lock.json")));
    assert.equal(lock.lockfileVersion,3);
    // Restore from the generated lock, then use the same public tests as authors.
    make("kit","deps",kit,"install","--project",project,"--directory","ts");
    await addExtensionUiFixture(project);
    make("kit","deps",kit,"add","--project",project,"--directory","ui");
    make("extension","validate","--project",project);
    make("extension","test","--project",project,"--integration","test.device");
    const result=make("extension","build","--project",project,"--integration","test.device","--output",output);
    assert.deepEqual(result.functions.map(f=>f.function).sort(),["connect","fetchConnectInfo","fetchDevices"]);
    assert.equal((await fs.stat(path.join(output,"fetchDevices.js"))).isFile(),true);
    const uiOutput=`${output}-ui`;
    const uiResult=make("extension","ui-build","--project",project,"--output",uiOutput);
    assert(uiResult.files.some(file=>file.path==="index.js"));
    assert(uiResult.files.some(file=>file.path==="manifest.json"));
    assert.equal(await fs.readFile(path.join(uiOutput,"index.js"),"utf8"),"export const ready=true;");
  } else {
    await fs.mkdir(project);
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
async function addExtensionUiFixture(project) {
  const descriptor=JSON.parse(await fs.readFile(path.join(project,"extension.json")));
  descriptor.ui="ui";
  await fs.writeFile(path.join(project,"extension.json"),JSON.stringify(descriptor));
  await fs.mkdir(path.join(project,"ui"));
  await fs.writeFile(path.join(project,"ui/package.json"),JSON.stringify({private:true,license:"Apache-2.0",scripts:{"build:extension":"node build.cjs"}}));
  const manifest={formatVersion:1,entries:{main:"index.js"},page:{entry:"main",title:"Fixture"}};
  await fs.writeFile(path.join(project,"ui/build.cjs"),
    "const fs=require('node:fs'),path=require('node:path'),output=process.argv[process.argv.indexOf('--output')+1];"+
    "fs.writeFileSync(path.join(output,'index.js'),'export const ready=true;');"+
    `fs.writeFileSync(path.join(output,'manifest.json'),${JSON.stringify(JSON.stringify(manifest))});`);
}
module.exports = { accept, acceptUiProjects, isolatedSystemTools, assertUiPreviewCommands, addExtensionUiFixture };
if (require.main === module)
  accept(...process.argv.slice(2)).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
