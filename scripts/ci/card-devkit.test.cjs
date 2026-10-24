const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { publish, promoteIndex, verifySource } = require("./card-devkit.cjs");
const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

test("index promotion preserves exact releases and cannot roll latest backwards", () => {
  const entry = {
    version: "1.10.0",
    manifestUrl: "https://example/1.10.0",
    sha256: "a",
  };
  const index = promoteIndex(
    { schemaVersion: 1, kind: "meow.card.devkit.index", versions: [] },
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
        { schemaVersion: 1, kind: "meow.card.devkit.index", versions: [] },
        { version: "latest" }
      ),
    /Expected exact version/
  );
});

test("publish verifies public bytes before CAS index promotion and refuses occupied version changes", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "card-devkit-release-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bytes = Buffer.from("standalone kit");
  fs.writeFileSync(path.join(root, "devkit.tar.gz"), bytes);
  const manifest = {
    schemaVersion: 1,
    kind: "meow.card.devkit",
    version: "1.6.0",
    files: [{ path: "devkit.tar.gz", size: bytes.length, sha256: hash(bytes) }],
  };
  fs.writeFileSync(path.join(root, "devkit.json"), JSON.stringify(manifest));
  const objects = new Map(),
    writes = [],
    reads = [];
  let corruptPublic = false;
  const command = (command, args) => {
    assert.equal(command, "aws");
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
      assert(reads.includes("card-devkit/1.6.0/devkit.json"));
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
  assert.equal(writes.at(-1), "card-devkit/index.json");
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
    "card-devkit/1.6.0/devkit.tar.gz",
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
  const oldTag = process.env.SOURCE_TAG,
    oldCommit = process.env.SOURCE_COMMIT;
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    if (oldTag === undefined) delete process.env.SOURCE_TAG;
    else process.env.SOURCE_TAG = oldTag;
    if (oldCommit === undefined) delete process.env.SOURCE_COMMIT;
    else process.env.SOURCE_COMMIT = oldCommit;
  });
  fs.mkdirSync(path.join(root, "src/ui-kit/cards/devkit"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), '{"version":"1.6.0"}');
  fs.writeFileSync(
    path.join(root, "src/ui-kit/cards/devkit/package.json"),
    '{"version":"2.0.0"}'
  );
  process.env.SOURCE_TAG = "card-devkit-v2.0.0";
  process.env.SOURCE_COMMIT = "a".repeat(40);
  const command = (_, args) =>
    args.includes("rev-parse") ? process.env.SOURCE_COMMIT : "";
  assert.equal(
    (await verifySource(root, { command })).tag,
    "card-devkit-v2.0.0"
  );
  process.env.SOURCE_TAG = "v1.6.0";
  await assert.rejects(verifySource(root, { command }), /must match/);
  process.env.SOURCE_TAG = "card-devkit-v2.0.0";
  await assert.rejects(
    verifySource(root, {
      command: (_, args) =>
        args.includes("rev-parse")
          ? process.env.SOURCE_COMMIT
          : " M tracked-file",
    }),
    /dirty/
  );
});

test("signed envelopes reject tampering and exact retries preserve signature bytes", async (t) => {
  const { execFileSync } = require("node:child_process");
  const { sign, decode, config } = require("./card-devkit.cjs");
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
    kind: "meow.card.devkit",
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
 for name,body in [("node-v1/bin/node",b"executable"),("node-v1/lib/node_modules/npm/package.json",b"{}")]:
  entry=tarfile.TarInfo(name);entry.size=len(body);entry.mtime=123;archive.addfile(entry,io.BytesIO(body))
 link=tarfile.TarInfo("node-v1/bin/npm");link.type=tarfile.SYMTYPE;link.linkname="../lib/node_modules/npm/package.json";archive.addfile(link)
`,
    path.join(root, "upstream.tar.gz"),
  ]);
  const normalize = path.join(__dirname, "card-node-archive.py");
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
  const { prepare, config } = require("./card-devkit.cjs");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "card-devkit-prepare-"));
  const old = JSON.parse(JSON.stringify(config));
  const names = [
    "CARD_ACCEPTANCE_CLI_VERSION",
    "GITHUB_SHA",
    "NODE_RELEASE_KEYRING",
  ];
  const environment = Object.fromEntries(
    names.map((name) => [name, process.env[name]])
  );
  t.after(() => {
    Object.assign(config, old);
    for (const name of names) {
      if (environment[name] === undefined) delete process.env[name];
      else process.env[name] = environment[name];
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  process.env.CARD_ACCEPTANCE_CLI_VERSION = "2.0.0";
  process.env.GITHUB_SHA = "b".repeat(40);
  process.env.NODE_RELEASE_KEYRING = "pinned-keyring";
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
  fs.writeFileSync(path.join(root, "devkit.tar.gz"), kit);
  fs.writeFileSync(
    path.join(root, "devkit-build.json"),
    JSON.stringify({
      version: "2.0.0",
      source: { tag: "card-devkit-v2.0.0", commit: "a".repeat(40) },
      workerProtocol: 1,
      minimumCliVersion: "2.0.0",
      files: [{ path: "devkit.tar.gz", size: kit.length, sha256: hash(kit) }],
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
      else assert.equal(name, "gpgv");
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
