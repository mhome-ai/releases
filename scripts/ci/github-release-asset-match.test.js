"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { decide, shouldSkipUpload } = require("./github-release-asset-match");

const digest = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

test("skips only an uploaded asset with the exact digest", () => {
  assert.equal(
    shouldSkipUpload({ name: "core.tar.gz", state: "uploaded", digest }, digest),
    true
  );
  assert.equal(decide(JSON.stringify({ assets: [
    { name: "core.tar.gz", state: "uploaded", digest },
  ] }), "core.tar.gz", digest), "skip");
});

test("uploads when the asset is missing, incomplete, or a different hash", () => {
  assert.equal(decide(JSON.stringify({ assets: [] }), "core.tar.gz", digest), "upload");
  assert.equal(
    decide(JSON.stringify({ assets: [
      { name: "core.tar.gz", state: "starter", digest },
    ] }), "core.tar.gz", digest),
    "upload"
  );
  assert.equal(
    decide(JSON.stringify({ assets: [
      { name: "core.tar.gz", state: "uploaded", digest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" },
    ] }), "core.tar.gz", digest),
    "upload"
  );
  assert.equal(
    decide(JSON.stringify({ assets: [
      { name: "core.tar.gz", state: "uploaded" },
    ] }), "core.tar.gz", digest),
    "upload"
  );
  assert.equal(
    shouldSkipUpload({ state: "uploaded", digest }, "deadbeef"),
    false
  );
});
