const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.join(__dirname, "../..");

function read(relative) {
  return fs.readFileSync(path.join(ROOT, relative), "utf8");
}

function workflowFiles() {
  return fs
    .readdirSync(path.join(ROOT, ".github/workflows"))
    .filter((name) => name.endsWith(".yaml"))
    .map((name) => `.github/workflows/${name}`);
}

test("workflows never clone and never use GitHub-hosted compile jobs", () => {
  for (const file of workflowFiles()) {
    const text = read(file);
    assert.doesNotMatch(text, /git clone/, file);
    assert.doesNotMatch(text, /actions\/checkout/, file);
    assert.doesNotMatch(text, /ubuntu-latest/, file);
    assert.doesNotMatch(text, /ubuntu-22\.04/, file);
    assert.doesNotMatch(text, /GPR_TOKEN/, file);
  }
});

test("native GitHub releases never steal Desktop Latest", () => {
  const script = read("scripts/ci/native-release.sh");
  assert.match(script, /gh release create/);
  assert.match(script, /--latest=false/);
  assert.match(script, /gh release edit/);
  assert.match(script, /--draft=false --latest=false/);
});

test("tagged orchestrator is taken from ~/.mhome/releases", () => {
  for (const file of [
    ".github/workflows/run-tagged.yaml",
    ".github/workflows/desktop-release.yaml",
    ".github/workflows/docker-release.yaml",
    ".github/workflows/deploy-native-install-script.yaml",
  ]) {
    const text = read(file);
    assert.match(text, /\$HOME\/\.mhome/, file);
    assert.match(text, /worktree add --detach/, file);
    assert.match(text, /scripts\/ci\/run\.sh/, file);
  }
});
