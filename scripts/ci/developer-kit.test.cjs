const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { publish, promoteIndex, verifySource } = require("./developer-kit.cjs");
const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

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

test("publish verifies public bytes before CAS index promotion and refuses occupied version changes", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "card-devkit-release-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bytes = Buffer.from("standalone kit");
  fs.writeFileSync(path.join(root, "kit.tar.gz"), bytes);
  const manifest = {
    schemaVersion: 1,
    kind: "meow.developer-kit",
    kit:"ui",
    version: "1.6.0",
    files: [{ path: "kit.tar.gz", size: bytes.length, sha256: hash(bytes) }],
  };
  fs.writeFileSync(path.join(root, "kit.json"), JSON.stringify(manifest));
  const objects = new Map(),
    writes = [],
    reads = [];
  let corruptPublic = false;
  const command = (command, args) => {
    assert.equal(command, "aws");
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
    objects.set(key, fs.readFileSync(args[args.indexOf("--body") + 1]));
    writes.push(key);
    return "{}";
  };
  const fetcher = async (url) => {
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
  await publish(root, {
    command,
    fetcher,
    verifyEnvelope: (bytes) => JSON.parse(bytes),
    signer: async (value) => Buffer.from(JSON.stringify(value)),
    promote: true,
  });
  assert.equal(writes.at(-1), "devkits/ui/index.json");
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
  corruptPublic = true;
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
  objects.set(
    "devkits/ui/1.6.0/kit.tar.gz",
    Buffer.from("different release")
  );
  await assert.rejects(
    publish(root, {
      command,
      fetcher,
      verifyEnvelope: (bytes) => JSON.parse(bytes),
    }),
    /Immutable DevKit/
  );
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

test("preparation freezes signed CLI assets for every platform, including the Windows asset key", async (t) => {
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
  assert.equal(Object.keys(manifest.platforms).length, 5);
  assert.equal(commands.filter((name) => name === "gpgv").length, 1);
  const frozen = JSON.parse(
    fs.readFileSync(path.join(root, "acceptance.json"))
  );
  assert.equal(
    frozen["win-x64"].asset.url,
    "https://example.invalid/win-x64.tar.gz"
  );
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
