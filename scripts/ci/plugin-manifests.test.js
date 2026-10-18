const test = require("node:test");
const assert = require("node:assert/strict");
const { prepareManifest } = require("./plugin-manifests");

test("repeated version publication reuses exact signed bytes", () => {
  let signs = 0;
  const verify = (manifest, signature) => assert.equal(signature, `signed:${manifest}`);
  const sign = (manifest) => { signs++; return `signed:${manifest}`; };
  const first = prepareManifest('{"version":"1.0.0"}', null, sign, verify);
  assert.equal(prepareManifest('{"version":"1.0.0"}', first, sign, verify), first);
  assert.equal(signs, 1);
  assert.throws(() => prepareManifest('{"version":"1.0.1"}', first, sign, verify), /changed at an existing version/);
});

test("malformed or invalid signed previous data cannot be reused", () => {
  const sign = () => { throw new Error("must not sign"); };
  assert.throws(() => prepareManifest("data", "{}", sign, () => {}), /Invalid existing/);
  const prior = JSON.stringify({schemaVersion: 1, kind: "meow.plugin.manifest-bundle", manifest: "data", signature: "bad"});
  assert.throws(() => prepareManifest("data", prior, sign, () => { throw new Error("Invalid signature"); }), /Invalid signature/);
});
