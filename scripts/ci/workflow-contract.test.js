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

function productWorkflows() {
  return workflowFiles().filter(
    (file) => !file.endsWith("/run-tagged.yaml")
  );
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

test("each product workflow is one job that calls run-tagged.yaml", () => {
  const files = productWorkflows();
  assert.ok(files.length >= 8, `expected split product workflows, got ${files.join(", ")}`);
  for (const file of files) {
    const text = read(file);
    assert.match(text, /uses: \.\/\.github\/workflows\/run-tagged\.yaml/, file);
    assert.doesNotMatch(text, /^\s+if:/m, file);
    assert.doesNotMatch(text, /^\s+environment:/m, file);
    assert.doesNotMatch(text, /worktree add --detach/, file);
    assert.doesNotMatch(text, /scripts\/ci\/run\.sh/, file);
  }
});

test("every product workflow names a GitHub Environment for the inner job", () => {
  const text = read(".github/workflows/run-tagged.yaml");
  assert.match(text, /github_environment:\n\s+required: true/);
  assert.equal(text.includes("environment: ${{ inputs.github_environment }}"), true);
  assert.doesNotMatch(text, /run_open:/);
  assert.doesNotMatch(text, /^\s+if:/m);
  for (const file of productWorkflows()) {
    const caller = read(file);
    assert.match(caller, /github_environment:/, file);
  }
  assert.match(
    read(".github/workflows/desktop-macos.yaml"),
    /github_environment: desktop-release/
  );
  assert.match(
    read(".github/workflows/desktop-windows.yaml"),
    /github_environment: desktop-release/
  );
});

test("docker release is a complete per-platform product", () => {
  const script = read("scripts/ci/docker-release.sh");
  assert.match(script, /docker\/stable\/\$\{platform\}/);
  assert.match(script, /docker\/catalogs\/\$\{version\}\/\$\{platform\}/);
  assert.match(script, /install-meow-docker-detect\.sh/);
  assert.match(script, /--platform "\$platform"/);
  assert.doesNotMatch(script, /skipping Docker Catalog/);
  assert.doesNotMatch(script, /require_cmd gh/);
});

test("linux native, docker, and install share one Docker host lock", () => {
  for (const file of [
    ".github/workflows/native-linux-arm64.yaml",
    ".github/workflows/native-linux-amd64.yaml",
    ".github/workflows/docker-linux-arm64.yaml",
    ".github/workflows/docker-linux-amd64.yaml",
    ".github/workflows/deploy-native-install-script.yaml",
  ]) {
    const text = read(file);
    assert.match(text, /group: linux-docker-host/, file);
    assert.match(text, /github_environment:/, file);
  }
});

test("install workflow assumes a dedicated native-install environment", () => {
  const text = read(".github/workflows/deploy-native-install-script.yaml");
  assert.match(text, /github_environment: native-install/);
});

test("tagged orchestrator is taken from ~/.mhome/releases", () => {
  const text = read(".github/workflows/run-tagged.yaml");
  assert.match(text, /\$HOME\/\.mhome/);
  assert.match(text, /worktree add --detach/);
  assert.match(text, /scripts\/ci\/run\.sh/);
  assert.match(text, /export WORK_ID=/);
  assert.match(text, /WORK_SUFFIX/);
  assert.match(text, /inputs\.channel == 'native'/);
  assert.match(text, /inputs\.channel == 'docker'/);
});

test("run.sh refuses a tag that does not match this runner", () => {
  const text = read("scripts/ci/run.sh");
  assert.match(text, /PRODUCT_CHANNEL" = "\$CHANNEL"/);
  assert.match(text, /PRODUCT_PLATFORM" = "\$WORK_SUFFIX"/);
});
