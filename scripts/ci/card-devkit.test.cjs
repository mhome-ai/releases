const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { publish, promoteIndex, provesSource } = require("./card-devkit.cjs");
const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

test("release identity must be recorded by successful validation, not incidental log text", () => {
  const commit = "a".repeat(40);
  assert(!provesSource(`refs/tags/v1.6.0\n${commit}`, "v1.6.0", commit));
  assert(
    provesSource(
      `validate\t2026-10-24 Validated Card DevKit source: v1.6.0 ${commit}`,
      "v1.6.0",
      commit
    )
  );
  assert(
    !provesSource(
      `Validated Card DevKit source: v1.5.0 ${commit}`,
      "v1.6.0",
      commit
    )
  );
});

test("index promotion preserves exact releases and cannot roll latest backwards", () => {
  const entry = {
    version: "1.10.0",
    manifestUrl: "https://example/1.10.0",
    sha256: "a",
  };
  const index = promoteIndex({ schemaVersion: 1, versions: [] }, entry);
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
      promoteIndex({ schemaVersion: 1, versions: [] }, { version: "latest" }),
    /Invalid/
  );
});

test("publish verifies public bytes before CAS index promotion and refuses occupied version changes", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "card-devkit-release-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bytes = Buffer.from("standalone kit");
  fs.writeFileSync(path.join(root, "devkit.tgz"), bytes);
  const manifest = {
    schemaVersion: 1,
    version: "1.6.0",
    files: [
      { path: "devkit.tgz", sizeBytes: bytes.length, sha256: hash(bytes) },
    ],
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
  await publish(root, { command, fetcher });
  assert.equal(writes.at(-1), "card-devkit/index.json");
  await publish(root, { command, fetcher }); // Exact retry accepts existing immutable bytes.
  const before = writes.length;
  corruptPublic = true;
  await assert.rejects(publish(root, { command, fetcher }), /Public delivery/);
  assert.equal(writes.length, before);
  corruptPublic = false;
  objects.set("card-devkit/1.6.0/devkit.tgz", Buffer.from("different release"));
  await assert.rejects(publish(root, { command, fetcher }), /Immutable DevKit/);
  assert.equal(writes.length, before);
});
