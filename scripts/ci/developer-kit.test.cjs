const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { publish, promoteIndex, verifySource } = require("./developer-kit.cjs");
const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

test("native acceptance rejects source patches masquerading as registry SDK installation", async t => {
  const {acceptNativeProjects}=require("./developer-kit-accept.cjs");
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),"kit-native-registry-"));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const make=(...args)=>{
    assert.equal(args[1],"init");
    const project=args[2];fs.mkdirSync(project);
    fs.writeFileSync(path.join(project,"extension.json"),'{"schemaVersion":1,"projectId":"test","plugin":"plugin.toml"}');
    fs.writeFileSync(path.join(project,"Cargo.lock"),'[[package]]\nname = "mhome-plugin-sdk"\nversion = "0.5.0"\n');
  };
  await assert.rejects(acceptNativeProjects({directory,version:"0.9.0",platform:"darwin-arm64",sdkVersion:"0.5.0",make}),/must resolve from the public registry/);
});

test("Extension acceptance compiles UI files with their required entry manifest", async t => {
  const {addExtensionUiFixture} = require("./developer-kit-accept.cjs");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kit-extension-ui-"));
  t.after(() => fs.rmSync(root, {recursive:true, force:true}));
  const descriptor={schemaVersion:1,projectId:"fixture",integrations:[{id:"test.device",schemaRoot:"schema",scriptProject:"ts",tests:"ts/tests"}]};
  fs.writeFileSync(path.join(root,"extension.json"),JSON.stringify(descriptor));
  await addExtensionUiFixture(root);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root,"extension.json"))),{...descriptor,ui:"ui"});
  const output=path.join(root,"compiled");fs.mkdirSync(output);
  require("node:child_process").execFileSync(process.execPath,[path.join(root,"ui/build.cjs"),"--output",output]);
  const manifest=JSON.parse(fs.readFileSync(path.join(output,"manifest.json")));
  assert.equal(manifest.formatVersion,1);
  assert.equal(manifest.page.entry,"main");
  assert.equal(fs.readFileSync(path.join(output,manifest.entries.main),"utf8"),"export const ready=true;");
});

test("UI acceptance rejects missing single-card commands without contacting an App", () => {
  const { assertUiPreviewCommands } = require("./developer-kit-accept.cjs");
  const usage = {
    inspect: "--space <SPACE> --card <CARD>",
    apply: "--space <SPACE> --base-ui <BASE> --card <CARD> --pattern <PATTERN> --renderer <RENDERER> --config <JSON>",
    status: "--space <SPACE> --base-ui <BASE>",
    stop: "--space <SPACE> --base-ui <BASE> --card <CARD> --pattern <PATTERN>",
  };
  const calls = [];
  const help = (...args) => {
    calls.push(args);
    assert.equal(args[0], "preview");
    assert.equal(args[2], "--help");
    return usage[args[1]];
  };
  assert.doesNotThrow(() => assertUiPreviewCommands(help));
  assert.equal(calls.length, 4);
  assert.throws(() => assertUiPreviewCommands((_, command) => {
    if (command === "inspect") throw new Error("unknown subcommand inspect");
    return usage[command];
  }), /unknown subcommand/);
  for (const command of ["apply", "stop"])
    assert.throws(() => assertUiPreviewCommands((_, name) =>
      name === command ? usage[name].replace("--card <CARD>", "--cardinality <N>") : usage[name]
    ), new RegExp(`${command} must support --card`));
});

test("an incompatible CLI is rejected before Node downloads or candidate publication", async (t) => {
  const { prepare } = require("./developer-kit.cjs");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kit-cli-minimum-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "kit-build.json"), JSON.stringify({
    kit: "ui", version: "3.2.2", minimumCliVersion: "1.15.0",
    source: { tag: "kit-ui-v3.2.2", commit: "a".repeat(40) },
  }));
  let downloads = 0;
  await assert.rejects(prepare(root, {
    cliVersion: "1.18.1", orchestratorCommit: "b".repeat(40),
    downloadFile: async () => { downloads++; throw new Error("unexpected download"); },
  }), /requires meow 1\.19\.0 or later; requested 1\.18\.1/);
  assert.equal(downloads, 0);
});

test("acceptance retains the real npm script shell without a system Node on PATH", async (t) => {
  const {isolatedSystemTools} = require('./developer-kit-accept.cjs');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-system-tools-'));
  t.after(() => fs.rmSync(directory, {recursive:true, force:true}));
  const tools = await isolatedSystemTools(directory);
  assert.deepEqual(fs.readdirSync(tools), ['sh']);
  const result = require('node:child_process').spawnSync('sh', ['-c',
    'if command -v node || command -v npm; then exit 1; fi; printf shell-ready'],
    {env:{...process.env, PATH:tools}, encoding:'utf8'});
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'shell-ready');
});

test("first publication reads authenticated S3 state and rejects permission or transport uncertainty", async (t) => {
  const {readExistingManifest} = require("./developer-kit.cjs");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "developer-kit-existing-"));
  t.after(() => fs.rmSync(root, {recursive:true, force:true}));
  let body, failure, present = false;
  const command = (name, args, options) => {
    assert.equal(name, "aws");
    const key = "devkits/extension/0.5.1/kit.json";
    assert.equal(options.timeout, 45000);
    if (args[1] === "list-objects-v2") {
      assert.equal(args[args.indexOf("--prefix") + 1], key);
      return JSON.stringify({KeyCount:present ? 1 : 0, Contents:present ? [{Key:key}] : []});
    }
    assert.equal(args[args.indexOf("--key") + 1], key);
    if (failure) {
      fs.writeFileSync(args.at(-1), "partial read");
      throw Object.assign(new Error("object read failed"), {stderr:failure});
    }
    fs.writeFileSync(args.at(-1), body);
    return JSON.stringify({ETag:'"original-etag"'});
  };
  assert.equal(await readExistingManifest(root, "extension", "0.5.1", command), undefined);
  assert.deepEqual(fs.readdirSync(root), []);
  present = true; body = Buffer.from("original signed bytes");
  assert.deepEqual(await readExistingManifest(root, "extension", "0.5.1", command), body);
  assert.deepEqual(fs.readdirSync(root), []);
  for (failure of ["An error occurred (AccessDenied)", "connection timed out", "An error occurred (NoSuchKey)", "upstream HTTP 404 without an S3 missing-object code"]) {
    await assert.rejects(readExistingManifest(root, "extension", "0.5.1", command), /object read failed/);
    assert.deepEqual(fs.readdirSync(root), []);
  }
  await assert.rejects(readExistingManifest(root,"extension","0.5.1",()=>"{}"),/Invalid publication state listing/);
  await assert.rejects(readExistingManifest(root,"extension","0.5.1",()=>{throw Error("list access denied");}),/list access denied/);
});

test("index promotion preserves exact releases and cannot roll latest backwards", () => {
  const entry = {
    version: "1.10.0",
    manifestUrl: "https://example/1.10.0",
    sha256: "a",
  };
  const index = promoteIndex(
    { schemaVersion: 1, kind: "meow.developer-kit.index", kit:"ui", versions: [] },
    entry
  );
  assert.equal(
    promoteIndex(index, { ...entry, version: "1.9.0" }).latest,
    "1.10.0"
  );
  assert.deepEqual(promoteIndex(index, entry), index);
  assert.throws(
    () => promoteIndex(index, { ...entry, sha256: "b" }),
    /changed/
  );
  assert.throws(
    () =>
      promoteIndex(
        { schemaVersion: 1, kind: "meow.developer-kit.index", kit:"ui", versions: [] },
        { version: "latest" }
      ),
    /Expected exact version/
  );
});

test("publish stores only metadata on S3 and verifies GitHub bytes before CAS index promotion", async (t) => {
  const { githubReleases } = require("./developer-release-test-fixture.cjs");
  const { assetUrl } = require("./github-developer-release.cjs");
  const github = githubReleases();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "card-devkit-release-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bytes = Buffer.from("standalone kit");
  const node = Buffer.from("managed Node");
  const declaration = Buffer.from("export type Card = object;");
  const tag = "kit-ui-v1.6.0";
  fs.writeFileSync(path.join(root, "kit.tar.gz"), bytes);
  fs.writeFileSync(path.join(root, "node-darwin-arm64.tar.gz"), node);
  fs.writeFileSync(path.join(root, "acceptance.json"), "{}");
  fs.writeFileSync(path.join(root, "default-pod.d.ts"), declaration);
  const kitFile = { path: "kit.tar.gz", size: bytes.length, sha256: hash(bytes) };
  const nodeFile = { path: "node-darwin-arm64.tar.gz", size: node.length, sha256: hash(node) };
  const asset = ({ path, ...metadata }) => ({ ...metadata, url: assetUrl(tag, path) });
  const manifest = {
    schemaVersion: 1,
    kind: "meow.developer-kit",
    kit:"ui",
    version: "1.6.0",
    source: { tag, commit: "a".repeat(40) },
    orchestratorCommit: "b".repeat(40),
    platforms: { "darwin-arm64": { payload: asset(kitFile), asset: asset(nodeFile) } },
    files: [
      kitFile,
      nodeFile,
      { path: "acceptance.json", size: 2, sha256: hash(Buffer.from("{}")) },
      { path: "default-pod.d.ts", size: declaration.length, sha256: hash(declaration) },
    ],
  };
  fs.writeFileSync(path.join(root, "kit.json"), JSON.stringify(manifest));
  const previous = {
    schemaVersion: 1, kind: "meow.developer-kit.index", kit: "ui",
    versions: [{ version: "1.5.0", manifestSha256: "c".repeat(64) }],
    latest: "1.5.0",
  };
  const objects = new Map([["devkits/ui/index.json", Buffer.from(JSON.stringify(previous))]]),
    writes = [],
    reads = [];
  let corruptPublic = false;
  const command = (command, args, options) => {
    if (command !== "aws") return github.command(command, args, options);
    if (args[1] === "list-objects-v2") {
      const prefix=args[args.indexOf("--prefix")+1];
      const keys=[...objects.keys()].filter(key=>key.startsWith(prefix)).sort().slice(0,1);
      return JSON.stringify({KeyCount:keys.length,Contents:keys.map(Key=>({Key}))});
    }
    const key = args[args.indexOf("--key") + 1];
    if (args[1] === "get-object") {
      if (!objects.has(key)) throw new Error("NoSuchKey");
      fs.writeFileSync(args.at(-1), objects.get(key));
      return JSON.stringify({ ETag: hash(objects.get(key)) });
    }
    if (objects.has(key) && args.includes("--if-none-match"))
      throw new Error("PreconditionFailed");
    if (args.includes("--if-match"))
      assert.equal(
        args[args.indexOf("--if-match") + 1],
        hash(objects.get(key))
      );
    if (key.endsWith("index.json"))
      assert(reads.includes("devkits/ui/1.6.0/kit.json"));
    assert(!key.endsWith(".tar.gz"), "S3 never receives the Kit or Node archive");
    assert.equal(github.releases.get(tag).isDraft, false);
    objects.set(key, fs.readFileSync(args[args.indexOf("--body") + 1]));
    writes.push(key);
    return "{}";
  };
  const fetcher = async (url) => {
    if (new URL(url).hostname === "github.com") {
      return new Response(corruptPublic ? "corrupt GitHub asset" : github.publicBytes(url));
    }
    const key = new URL(url).pathname.slice(1);
    reads.push(key);
    return new Response(corruptPublic ? "corrupt CDN" : objects.get(key));
  };
  await publish(root, {
    command,
    fetcher,
    verifyEnvelope: (bytes) => JSON.parse(bytes),
    signer: async (value) => Buffer.from(JSON.stringify(value)),
  });
  assert.equal(writes.includes("devkits/ui/index.json"), false);
  assert.deepEqual(objects.get("devkits/ui/1.6.0/default-pod.d.ts"), declaration);
  assert.equal(github.releases.get(tag).files.has("default-pod.d.ts"), false);
  await publish(root, {
    command,
    fetcher,
    verifyEnvelope: (bytes) => JSON.parse(bytes),
    signer: async (value) => Buffer.from(JSON.stringify(value)),
    promote: true,
  });
  assert.equal(writes.at(-1), "devkits/ui/index.json");
  assert.deepEqual(JSON.parse(objects.get("devkits/ui/index.json")).versions.map(item => item.version), ["1.5.0", "1.6.0"]);
  await publish(root, {
    command,
    fetcher,
    verifyEnvelope: (bytes) => JSON.parse(bytes),
    signer: async (value) => Buffer.from(JSON.stringify(value)),
  });
  await publish(root, {
    command,
    fetcher,
    verifyEnvelope: (bytes) => JSON.parse(bytes),
    signer: async (value) => Buffer.from(JSON.stringify(value)),
    promote: true,
  }); // Exact retry accepts existing immutable bytes.
  const before = writes.length;
  assert.equal(github.calls.filter(call => call.action === "upload").length, 2);
  corruptPublic = true;
  await assert.rejects(publish(root, {
    command, fetcher, verifyEnvelope: (bytes) => JSON.parse(bytes), promote: true,
  }), /Public delivery/);
  await assert.rejects(
    publish(root, {
      command,
      fetcher,
      verifyEnvelope: (bytes) => JSON.parse(bytes),
    }),
    /Public delivery/
  );
  assert.equal(writes.length, before);
  corruptPublic = false;
  github.releases.get(tag).files.set("kit.tar.gz", Buffer.from("different release"));
  await assert.rejects(
    publish(root, {
      command,
      fetcher,
      verifyEnvelope: (bytes) => JSON.parse(bytes),
    }),
    /Immutable GitHub release asset differs/
  );
  assert.equal(writes.length, before);
  github.releases.get(tag).files.set("kit.tar.gz", bytes);
  objects.set("devkits/ui/1.6.0/kit.json", Buffer.from("original version metadata differs"));
  await assert.rejects(publish(root, {
    command, fetcher, verifyEnvelope: (bytes) => JSON.parse(bytes),
  }), /Immutable DevKit file differs/);
  assert.equal(writes.length, before);
});

test("DevKit source identity is independent of App version and rejects a dirty checkout", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "card-devkit-source-"));
  t.after(() => fs.rmSync(root,{recursive:true,force:true}));
  fs.mkdirSync(path.join(root, "tools/card-devkit"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), '{"version":"1.6.0"}');
  fs.writeFileSync(
    path.join(root, "tools/card-devkit/package.json"),
    '{"version":"2.0.0"}'
  );
  const options = {kit:"ui",tag:"kit-ui-v2.0.0",commit:"a".repeat(40)};
  const command = (_,args) => args.includes("rev-parse") ? options.commit : "";
  assert.equal((await verifySource(root,{...options,command})).tag,options.tag);
  await assert.rejects(verifySource(root,{...options,tag:"v1.6.0",command}),/must match/);
  await assert.rejects(verifySource(root,{...options,command:(_,args)=>args.includes("rev-parse")?options.commit:" M tracked-file"}),/dirty/);

});

test("signed envelopes reject tampering and exact retries preserve signature bytes", async (t) => {
  const { execFileSync } = require("node:child_process");
  const { sign, decode, config } = require("./developer-kit.cjs");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "card-devkit-signature-"));
  const oldKey = config.publicKey,
    oldSecret = process.env.RUNTIME_CATALOG_PRIVATE_KEY_B64;
  t.after(() => {
    config.publicKey = oldKey;
    if (oldSecret === undefined)
      delete process.env.RUNTIME_CATALOG_PRIVATE_KEY_B64;
    else process.env.RUNTIME_CATALOG_PRIVATE_KEY_B64 = oldSecret;
    fs.rmSync(root, { recursive: true, force: true });
  });
  execFileSync(
    "minisign",
    [
      "-G",
      "-W",
      "-p",
      path.join(root, "public"),
      "-s",
      path.join(root, "secret"),
    ],
    { stdio: "pipe" }
  );
  config.publicKey = fs
    .readFileSync(path.join(root, "public"), "utf8")
    .trim()
    .split("\n")
    .at(-1);
  process.env.RUNTIME_CATALOG_PRIVATE_KEY_B64 = fs
    .readFileSync(path.join(root, "secret"))
    .toString("base64");
  const value = {
    schemaVersion: 1,
    kind: "meow.developer-kit",
    kit:"ui",
    version: "2.0.0",
  };
  const first = await sign(value, root);
  assert.deepEqual(decode(first, root), value);
  assert.deepEqual(await sign(value, root, first), first);
  await assert.rejects(
    sign({ ...value, version: "2.0.1" }, root, first),
    /differs/
  );
  const changed = JSON.parse(first);
  changed.payload = changed.payload.replace("2.0.0", "2.0.1");
  assert.throws(() => decode(Buffer.from(JSON.stringify(changed)), root));
});

test("normalized Node archives are deterministic and reject escaping links", (t) => {
  const { execFileSync } = require("node:child_process");
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "card-node-normalization-")
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  execFileSync("python3", [
    "-c",
    `import io,tarfile,sys
with tarfile.open(sys.argv[1],"w:gz") as archive:
 for name,body,mode in [("node-v1/bin/node",b"executable",0o755),("node-v1/lib/node_modules/npm/package.json",b"{}",0o644),("node-v1/lib/node_modules/npm/bin/npm-cli.js",b"#!/bin/sh\\necho managed-npm-ready\\n",0o755)]:
  entry=tarfile.TarInfo(name);entry.size=len(body);entry.mode=mode;entry.mtime=123;archive.addfile(entry,io.BytesIO(body))
 link=tarfile.TarInfo("node-v1/bin/npm");link.type=tarfile.SYMTYPE;link.linkname="../lib/node_modules/npm/bin/npm-cli.js";archive.addfile(link)
`,
    path.join(root, "upstream.tar.gz"),
  ]);
  const normalize = path.join(__dirname, "developer-node-archive.py");
  execFileSync("python3", [
    normalize,
    path.join(root, "upstream.tar.gz"),
    path.join(root, "one.tar.gz"),
  ]);
  execFileSync("python3", [
    normalize,
    path.join(root, "upstream.tar.gz"),
    path.join(root, "two.tar.gz"),
  ]);
  assert.deepEqual(
    fs.readFileSync(path.join(root, "one.tar.gz")),
    fs.readFileSync(path.join(root, "two.tar.gz"))
  );
  execFileSync("python3", ["-c", `import tarfile,sys
with tarfile.open(sys.argv[1]) as archive:
 assert archive.getmember("lib/node_modules/npm/bin/npm-cli.js").mode == 0o755
 assert archive.getmember("lib/node_modules/npm/package.json").mode == 0o644
 archive.extractall(sys.argv[2])
`, path.join(root,"one.tar.gz"),path.join(root,"installed")]);
  if (process.platform !== "win32") assert.equal(
    execFileSync(path.join(root,"installed/bin/npm"),[],{encoding:"utf8"}).trim(),
    "managed-npm-ready"
  );
  execFileSync("python3", [
    "-c",
    `import tarfile,sys
with tarfile.open(sys.argv[1],"w:gz") as archive:
 entry=tarfile.TarInfo("node-v1/escape");entry.type=tarfile.SYMTYPE;entry.linkname="../../outside";archive.addfile(entry)
`,
    path.join(root, "bad.tar.gz"),
  ]);
  assert.throws(() =>
    execFileSync(
      "python3",
      [
        normalize,
        path.join(root, "bad.tar.gz"),
        path.join(root, "bad-output.tar.gz"),
      ],
      { stdio: "pipe" }
    )
  );
});

test("preparation freezes signed CLI assets for all four advertised Mac/Linux platforms", async (t) => {
  const { execFileSync } = require("node:child_process");
  const { prepare, config } = require("./developer-kit.cjs");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "card-devkit-prepare-"));
  const old = JSON.parse(JSON.stringify(config));
  t.after(() => {Object.assign(config,old);fs.rmSync(root,{recursive:true,force:true});});
  execFileSync(
    "minisign",
    [
      "-G",
      "-W",
      "-p",
      path.join(root, "key.pub"),
      "-s",
      path.join(root, "key"),
    ],
    { stdio: "pipe" }
  );
  config.publicKey = fs
    .readFileSync(path.join(root, "key.pub"), "utf8")
    .trim()
    .split("\n")
    .at(-1);
  const kit = Buffer.from("kit"),
    node = Buffer.from("upstream node"),
    signatures = new Map();
  fs.writeFileSync(path.join(root, "kit.tar.gz"), kit);
  fs.writeFileSync(
    path.join(root, "kit-build.json"),
    JSON.stringify({
      kit:"ui",
      version: "2.0.0",
      source: { tag: "kit-ui-v2.0.0", commit: "a".repeat(40) },
      workerProtocol: 1,
      minimumCliVersion: "2.0.0",
      files: [{ path: "kit.tar.gz", size: kit.length, sha256: hash(kit) }],
    })
  );
  let sums = "";
  for (const [platform, pin] of Object.entries(config.platforms)) {
    pin.sha256 = hash(node);
    sums += `${pin.sha256}  node-v${config.nodeVersion}-${platform}.${
      platform === "win-x64" ? "zip" : "tar.gz"
    }\n`;
    const native = platform === "win-x64" ? "windows" : platform;
    const assetKey = platform === "win-x64" ? "windows-x64" : platform;
    const bytes = Buffer.from(
      JSON.stringify({
        components: {
          client: {
            version: "2.0.0",
            assets: {
              [assetKey]: {
                url: `https://example.invalid/${platform}.tar.gz`,
                size: 1,
                sha256: "c".repeat(64),
              },
            },
          },
        },
      })
    );
    const file = path.join(root, `catalog-${platform}`);
    fs.writeFileSync(file, bytes);
    execFileSync("minisign", ["-Sm", file, "-s", path.join(root, "key")], {
      stdio: "pipe",
    });
    signatures.set(`/runtime/stable/${native}/catalog.json`, bytes);
    signatures.set(
      `/runtime/stable/${native}/catalog.json.minisig`,
      fs.readFileSync(`${file}.minisig`)
    );
  }
  const commands = [];
  const manifest = await prepare(root, {
    cliVersion:"2.0.0",orchestratorCommit:"b".repeat(40),
    downloadFile: async (url) => {
      const pathname = new URL(url).pathname;
      if (signatures.has(pathname)) return signatures.get(pathname);
      if (pathname.endsWith("SHASUMS256.txt")) return Buffer.from(sums);
      if (pathname.endsWith("SHASUMS256.txt.sig"))
        return Buffer.from("signature");
      return node;
    },
    command: (name, args) => {
      commands.push(name);
      if (name === "python3") fs.writeFileSync(args.at(-1), "normalized node");
      else assert(["gpg", "gpgv"].includes(name));
    },
    existingEnvelope: async () => undefined,
    signer: async (value) => Buffer.from(JSON.stringify(value)),
  });
  assert.equal(manifest.version, "2.0.0");
  assert.equal(manifest.minimumCliVersion, "2.0.0");
  assert.deepEqual(Object.keys(manifest.platforms), ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64']);
  assert.equal(manifest.platforms["darwin-arm64"].payload.url,
    "https://github.com/mhome-ai/releases/releases/download/kit-ui-v2.0.0/kit.tar.gz");
  assert.equal(manifest.platforms["linux-x64"].asset.url,
    "https://github.com/mhome-ai/releases/releases/download/kit-ui-v2.0.0/node-linux-x64.tar.gz");
  assert.equal(commands.filter((name) => name === "gpgv").length, 1);
  const frozen = JSON.parse(
    fs.readFileSync(path.join(root, "acceptance.json"))
  );
  assert.equal(
    frozen["linux-x64"].asset.url,
    "https://example.invalid/linux-x64.tar.gz"
  );
  assert.equal(frozen['win-x64'], undefined);
  assert(manifest.files.some((file) => file.path === "acceptance.json"));
});


test("publication binds frozen commits to the canonical source repository",()=>{
 const {assertOrigin}=require('./developer-kit-job.cjs');
 for(const origin of ['git@github.com:mhome-ai/script.git','ssh://git@github.com/mhome-ai/script.git','https://github.com/mhome-ai/script.git'])
  assert.doesNotThrow(()=>assertOrigin('/source','script',()=>origin));
 for(const origin of ['https://github.com/other/script.git','https://example.invalid/mhome-ai/script.git'])
  assert.throws(()=>assertOrigin('/source','script',()=>origin),/Expected the mhome-ai/);
});

test("source tag verification refetches remote state and rejects moved or deleted tags",()=>{
 const {verifySourceTag}=require('./developer-kit-job.cjs');
 const expected='a'.repeat(40),tag='kit-ui-v3.2.0',calls=[];
 let remote=expected;
 const command=(_,args)=>{
  calls.push(args);
  if(args.includes('remote'))return 'git@github.com:mhome-ai/pallas-cat.git';
  if(args.includes('fetch')){if(remote===null)throw Error('remote tag deleted');return '';}
  return remote;
 };
 verifySourceTag('/source','pallas-cat',tag,expected,command);
 remote='b'.repeat(40);
 assert.throws(()=>verifySourceTag('/source','pallas-cat',tag,expected,command),/Source tag moved/);
 remote=null;
 assert.throws(()=>verifySourceTag('/source','pallas-cat',tag,expected,command),/remote tag deleted/);
 assert.equal(calls.filter(args=>args.includes('fetch')).length,3);
});
