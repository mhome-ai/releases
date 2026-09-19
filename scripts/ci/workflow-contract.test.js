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
    assert.match(text, /^\s+packages: write$/m, file);
    assert.doesNotMatch(text, /^\s+if:/m, file);
    assert.doesNotMatch(text, /^\s+environment:/m, file);
    assert.doesNotMatch(text, /worktree add --detach/, file);
    assert.doesNotMatch(text, /scripts\/ci\/run\.sh/, file);
  }
});

test("run-tagged has one job and does not use GitHub Environments", () => {
  const text = read(".github/workflows/run-tagged.yaml");
  assert.doesNotMatch(text, /github_environment/);
  assert.doesNotMatch(text, /^\s+environment:/m);
  assert.doesNotMatch(text, /run_open:/);
  assert.doesNotMatch(text, /^\s+if:/m);
  for (const file of productWorkflows()) {
    const caller = read(file);
    assert.doesNotMatch(caller, /github_environment/, file);
    assert.doesNotMatch(caller, /^\s+environment:/m, file);
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
  }
});

test("install workflow dispatches from current orchestrator SHA", () => {
  const text = read(".github/workflows/deploy-native-install-script.yaml");
  assert.equal(text.includes("orchestrator_ref: ${{ github.sha }}"), true);
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
  assert.match(text, /vars\.RUNTIME_PUBLISH_ROLE_ARN/);
  assert.match(text, /vars\.DOCKER_DISTRIBUTION_PUBLISH_ROLE_ARN/);
  assert.match(text, /vars\.NATIVE_INSTALL_PUBLISH_ROLE_ARN/);
  assert.match(text, /vars\.APPLE_TEAM_ID/);
});

test("install.mhome.ai URL and bucket are pinned; role ARNs come from org vars", () => {
  const lib = read("scripts/ci/lib.sh");
  assert.match(lib, /https:\/\/install\.mhome\.ai/);
  assert.match(lib, /mhome-install-distribution/);
  assert.doesNotMatch(lib, /arn:aws:iam::/);
  assert.doesNotMatch(lib, /APPLE_TEAM_ID=/);
  const yaml = read(".github/workflows/run-tagged.yaml");
  assert.match(yaml, /vars\.RUNTIME_PUBLISH_ROLE_ARN/);
  assert.match(yaml, /vars\.DOCKER_DISTRIBUTION_PUBLISH_ROLE_ARN/);
  assert.match(yaml, /vars\.NATIVE_INSTALL_PUBLISH_ROLE_ARN/);
  assert.match(yaml, /vars\.APPLE_TEAM_ID/);
  assert.doesNotMatch(yaml, /vars\.AWS_REGION/);
  assert.doesNotMatch(yaml, /RUNTIME_CATALOG_BUCKET/);
  assert.doesNotMatch(yaml, /DOCKER_DISTRIBUTION_BUCKET/);
});

test("linux runner entrypoints clone ~/.mhome sources at start", () => {
  const script = read("runners/ensure-mhome-sources.sh");
  assert.match(script, /git clone/);
  assert.match(script, /baycat/);
  assert.match(script, /meowcore-rust/);
  assert.match(script, /releases/);
  assert.doesNotMatch(script, /pallas-cat/);
  for (const file of [
    "runners/linux-arm64/entrypoint.sh",
    "runners/linux-amd64/entrypoint.sh",
  ]) {
    assert.match(read(file), /ensure-mhome-sources\.sh/, file);
  }
  for (const file of [
    "runners/linux-arm64/Dockerfile",
    "runners/linux-amd64/Dockerfile",
  ]) {
    assert.match(read(file), /ensure-mhome-sources\.sh/, file);
  }
  for (const file of [
    "runners/linux-arm64/compose.yaml",
    "runners/linux-amd64/compose.yaml",
  ]) {
    assert.match(read(file), /context: \.\./, file);
  }
});

test("run.sh refuses a tag that does not match this runner", () => {
  const text = read("scripts/ci/run.sh");
  assert.match(text, /PRODUCT_CHANNEL" = "\$CHANNEL"/);
  assert.match(text, /PRODUCT_PLATFORM" = "\$WORK_SUFFIX"/);
});
