"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { resolveProductTag } = require("./resolve-product-tag");

test("parses independent native platform tags", () => {
  assert.deepEqual(resolveProductTag("nlr20261001121600"), {
    channel: "native",
    prefix: "nlr",
    platform: "linux-arm64",
    version: "20261001121600",
    sourceTag: "",
    sourceMode: "pin",
    releaseTag: "nlr20261001121600",
    withPallas: false,
    withMeowcore: true,
  });
  assert.equal(resolveProductTag("refs/tags/nlx20261001121600").platform, "linux-x64");
  assert.equal(resolveProductTag("nmr20261001121600").platform, "darwin-arm64");
  assert.equal(resolveProductTag("nmx20261001121600").platform, "darwin-x64");
  assert.equal(resolveProductTag("nw20261001121600").platform, "windows");
  assert.throws(() => resolveProductTag("nlr1.2.3"), /YYYYMMDDHHMMSS/);
});

test("parses desktop tags onto canonical aX.Y.Z GitHub release", () => {
  assert.equal(resolveProductTag("am1.2.3").releaseTag, "a1.2.3");
  assert.equal(resolveProductTag("am1.2.3").sourceTag, "v1.2.3");
  assert.equal(resolveProductTag("am1.2.3").withPallas, true);
  assert.equal(resolveProductTag("aw1.2.3").platform, "windows");
});

test("parses docker tags", () => {
  assert.equal(resolveProductTag("dlr1.2.3").channel, "docker");
  assert.equal(resolveProductTag("dlr1.2.3").platform, "linux-arm64");
  assert.equal(resolveProductTag("dlx1.2.3").platform, "linux-x64");
  assert.equal(resolveProductTag("dlr1.2.3").sourceTag, "v1.2.3");
});

test("does not let n steal nlr or a steal am", () => {
  assert.equal(resolveProductTag("nlr20261001121600").prefix, "nlr");
  assert.equal(resolveProductTag("am1.0.0").prefix, "am");
});

test("rejects unknown tags", () => {
  assert.throws(() => resolveProductTag("v1.2.3"), /Invalid product release tag/);
  assert.throws(() => resolveProductTag("nl1.2.3"), /Invalid product release tag/);
  assert.throws(() => resolveProductTag("nm1.2.3"), /Invalid product release tag/);
  assert.throws(() => resolveProductTag("nmd1.2.3"), /Invalid product release tag/);
  assert.throws(() => resolveProductTag("n1.2.3"), /Invalid product release tag/);
  assert.throws(() => resolveProductTag("a1.2.3"), /Invalid product release tag/);
  assert.throws(() => resolveProductTag("d1.2.3"), /Invalid product release tag/);
});
