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
    assert.doesNotMatch(text, /actions\/upload-artifact/, file);
    assert.doesNotMatch(text, /actions\/download-artifact/, file);
    assert.doesNotMatch(text, /^\s+needs:/m, file);
  }
});

test("native GitHub releases never steal Desktop Latest", () => {
  const script = read("scripts/ci/native-release.sh");
  assert.match(script, /gh release create/);
  assert.match(script, /--latest=false/);
  assert.match(script, /gh release edit/);
  assert.match(script, /--draft=false --latest=false/);
});

test("product workflows only select a runner and call run-tagged.yaml", () => {
  for (const file of [
    ".github/workflows/native-runtime-release.yaml",
    ".github/workflows/desktop-release.yaml",
    ".github/workflows/docker-release.yaml",
    ".github/workflows/deploy-native-install-script.yaml",
  ]) {
    const text = read(file);
    assert.match(text, /uses: \.\/\.github\/workflows\/run-tagged\.yaml/, file);
    assert.doesNotMatch(text, /worktree add --detach/, file);
    assert.doesNotMatch(text, /scripts\/ci\/run\.sh/, file);
  }
});

test("docker release is a complete per-platform product", () => {
  const script = read("scripts/ci/docker-release.sh");
  assert.match(script, /docker\/stable\/\$\{platform\}/);
  assert.match(script, /docker\/catalogs\/\$\{version\}\/\$\{platform\}/);
  assert.match(script, /install-meow-docker-detect\.sh/);
  assert.match(script, /--platform "\$platform"/);
  assert.doesNotMatch(script, /skipping Docker Catalog/);
  assert.doesNotMatch(script, /require_cmd gh/);
  const workflow = read(".github/workflows/docker-release.yaml");
  assert.match(workflow, /docker-stable-linux-arm64/);
  assert.match(workflow, /docker-stable-linux-amd64/);
  assert.doesNotMatch(workflow, /group: docker-release/);
});

test("install workflow assumes a dedicated native-install environment", () => {
  const text = read(".github/workflows/deploy-native-install-script.yaml");
  assert.match(text, /environment: native-install/);
});

test("tagged orchestrator is taken from ~/.mhome/releases", () => {
  const text = read(".github/workflows/run-tagged.yaml");
  assert.match(text, /\$HOME\/\.mhome/);
  assert.match(text, /worktree add --detach/);
  assert.match(text, /scripts\/ci\/run\.sh/);
  assert.match(text, /export WORK_ID=/);
  assert.match(text, /WORK_SUFFIX/);
});
