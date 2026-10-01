"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { resolveProductTag } = require("./resolve-product-tag");
const { nextAttemptTag } = require("./next-attempt-tag");

test("parses independent native platform attempt tags", () => {
  assert.deepEqual(resolveProductTag("nlr20261001-01"), {
    channel: "native",
    prefix: "nlr",
    platform: "linux-arm64",
    version: "20261001-01",
    sourceTag: "t20261001-01",
    sourceMode: "attempt",
    releaseTag: "nlr20261001-01",
    withPallas: false,
    withMeowcore: true,
  });
  assert.equal(resolveProductTag("refs/tags/nlx20261001-02").platform, "linux-x64");
  assert.equal(resolveProductTag("nmr20261001-01").platform, "darwin-arm64");
  assert.equal(resolveProductTag("nmx20261001-01").platform, "darwin-x64");
  assert.equal(resolveProductTag("nw20261001-01").platform, "windows");
  assert.throws(() => resolveProductTag("nlr1.2.3"), /YYYYMMDD-NN/);
  assert.throws(() => resolveProductTag("nlr20261001121600"), /YYYYMMDD-NN/);
});

test("parses desktop and docker attempt tags onto the same source snapshot", () => {
  const desktop = resolveProductTag("am20261001-01");
  assert.equal(desktop.releaseTag, "am20261001-01");
  assert.equal(desktop.sourceTag, "t20261001-01");
  assert.equal(desktop.sourceMode, "attempt");
  assert.equal(desktop.withPallas, true);
  assert.equal(resolveProductTag("aw20261001-01").platform, "windows");
  const docker = resolveProductTag("dlr20261001-01");
  assert.equal(docker.channel, "docker");
  assert.equal(docker.platform, "linux-arm64");
  assert.equal(docker.sourceTag, "t20261001-01");
  assert.equal(resolveProductTag("dlx20261001-01").platform, "linux-x64");
  assert.throws(() => resolveProductTag("am1.2.3"), /YYYYMMDD-NN/);
  assert.throws(() => resolveProductTag("dlr1.2.3"), /YYYYMMDD-NN/);
});

test("does not let n steal nlr or a steal am", () => {
  assert.equal(resolveProductTag("nlr20261001-01").prefix, "nlr");
  assert.equal(resolveProductTag("am20261001-01").prefix, "am");
});

test("allocates the next UTC attempt tag", () => {
  const date = new Date("2026-10-01T16:00:00Z");
  assert.equal(nextAttemptTag([], date), "t20261001-01");
  assert.equal(nextAttemptTag(["t20261001-01", "t20261001-02"], date), "t20261001-03");
  assert.equal(nextAttemptTag(["t20260930-09"], date), "t20261001-01");
});

test("rejects unknown tags", () => {
  assert.throws(() => resolveProductTag("v1.2.3"), /Invalid product release tag/);
  assert.throws(() => resolveProductTag("t20261001-01"), /Invalid product release tag/);
  assert.throws(() => resolveProductTag("nl1.2.3"), /Invalid product release tag/);
  assert.throws(() => resolveProductTag("nm1.2.3"), /Invalid product release tag/);
  assert.throws(() => resolveProductTag("nmd1.2.3"), /Invalid product release tag/);
  assert.throws(() => resolveProductTag("n1.2.3"), /Invalid product release tag/);
  assert.throws(() => resolveProductTag("a1.2.3"), /Invalid product release tag/);
  assert.throws(() => resolveProductTag("d1.2.3"), /Invalid product release tag/);
  assert.throws(() => resolveProductTag("nmr20261001-00"), /YYYYMMDD-NN/);
});
