const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveProductTag } = require("./resolve-product-tag");
const { verifyPromotion } = require("./verify-catalog-promotion");

test("plugin tags use independent source and release channels", () => {
  for (const [prefix, platform] of [
    ["pnmr", "darwin-arm64"],
    ["pnmx", "darwin-x64"],
    ["pnlr", "linux-arm64"],
    ["pnlx", "linux-x64"],
  ]) {
    const result = resolveProductTag(`${prefix}20261001-01`);
    assert.equal(result.channel, "plugin");
    assert.equal(result.platform, platform);
    assert.equal(result.sourceMode, "attempt");
    assert.equal(result.sourceTag, "t20261001-01");
    assert.equal(result.withMeowcore, false);
  }
});
test("promotion permits exact retries, rejects rollback and same-version changes", () => {
  const catalog = (version, extra = {}) =>
    Buffer.from(
      JSON.stringify({
        kind: "meow.plugin.catalog",
        channel: "stable",
        releaseVersion: version,
        ...extra,
      })
    );
  verifyPromotion(catalog("1.0.5"), catalog("1.0.5"));
  verifyPromotion(catalog("1.0.5"), catalog("1.0.6"));
  assert.throws(
    () => verifyPromotion(catalog("1.0.5"), catalog("1.0.4")),
    /backwards/
  );
  assert.throws(
    () =>
      verifyPromotion(catalog("1.0.5"), catalog("1.0.5", { changed: true })),
    /same version/
  );
  assert.throws(
    () =>
      verifyPromotion(catalog("1.0.5"), catalog("1.0.6", { kind: undefined })),
    /source changed/
  );
});

test("retired appliance tags are not product tags", () => {
  assert.throws(() => resolveProductTag("pdlr20261001-01"), /Invalid product release tag/);
  assert.throws(() => resolveProductTag("pdlx20261001-01"), /Invalid product release tag/);
});
test("atomic Plugin envelope preserves exact signature input bytes", (t) => {
  const fs = require("node:fs"),
    os = require("node:os"),
    path = require("node:path");
  const { pack, unpack } = require("./plugin-catalog-bundle");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-bundle-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(root, "catalog"),
    '{ "releaseVersion": "1.0.5" }\n'
  );
  fs.writeFileSync(path.join(root, "signature"), "signature\n");
  pack(
    path.join(root, "catalog"),
    path.join(root, "signature"),
    path.join(root, "bundle")
  );
  unpack(
    path.join(root, "bundle"),
    path.join(root, "restored"),
    path.join(root, "restored-signature")
  );
  assert.deepEqual(
    fs.readFileSync(path.join(root, "restored")),
    fs.readFileSync(path.join(root, "catalog"))
  );
  assert.deepEqual(
    fs.readFileSync(path.join(root, "restored-signature")),
    fs.readFileSync(path.join(root, "signature"))
  );
});
