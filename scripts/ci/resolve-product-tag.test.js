"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  resolveNativeDispatch,
  resolveProductTag,
} = require("./resolve-product-tag");

test("parses independent native platform tags", () => {
  assert.deepEqual(resolveProductTag("nlr1.2.3"), {
    channel: "native",
    prefix: "nlr",
    platform: "linux-arm64",
    version: "1.2.3",
    sourceTag: "v1.2.3",
    releaseTag: "nlr1.2.3",
    withPallas: false,
    withMeowcore: true,
  });
  assert.equal(resolveProductTag("refs/tags/nlx0.9.27").platform, "linux-amd64");
  assert.equal(resolveProductTag("nm1.0.0").platform, "macos");
  assert.equal(resolveProductTag("nw1.0.0").platform, "windows");
});

test("parses desktop tags onto canonical aX.Y.Z GitHub release", () => {
  assert.equal(resolveProductTag("am1.2.3").releaseTag, "a1.2.3");
  assert.equal(resolveProductTag("am1.2.3").sourceTag, "v1.2.3");
  assert.equal(resolveProductTag("am1.2.3").withPallas, true);
  assert.equal(resolveProductTag("a1.2.3").platform, "all");
});

test("parses docker tags", () => {
  assert.equal(resolveProductTag("d1.2.3").channel, "docker");
  assert.equal(resolveProductTag("d1.2.3").sourceTag, "v1.2.3");
});

test("does not let n steal nlr or a steal am", () => {
  assert.equal(resolveProductTag("nlr1.0.0").prefix, "nlr");
  assert.equal(resolveProductTag("am1.0.0").prefix, "am");
});

test("rejects unknown tags", () => {
  assert.throws(() => resolveProductTag("v1.2.3"), /Invalid product release tag/);
  assert.throws(() => resolveProductTag("nl1.2.3"), /Invalid product release tag/);
  assert.throws(() => resolveProductTag("n1.2.3"), /Invalid product release tag/);
});

test("native dispatch from tag does not read package.json", () => {
  assert.deepEqual(
    resolveNativeDispatch({ event: "push", ref: "nlr1.2.3" }),
    { version: "1.2.3", platforms: ["linux-arm64"] }
  );
  assert.deepEqual(
    resolveNativeDispatch({
      event: "workflow_dispatch",
      version: "1.2.3",
      platform: "linux-amd64",
    }),
    { version: "1.2.3", platforms: ["linux-amd64"] }
  );
});
