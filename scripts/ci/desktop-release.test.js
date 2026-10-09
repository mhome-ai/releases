const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

// Run the actual orchestrator against an already public release. The fixture
// deliberately has no build/signing scripts, so attempting to rebuild fails.
function resume(
  t,
  { version = "1.0.6", revision = "frozen-source", lookupError, draft = false } = {}
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "desktop resume test "));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ci = path.join(root, "ci"),
    bin = path.join(root, "bin"),
    baycat = path.join(root, "baycat");
  const scripts = path.join(baycat, "scripts/release"),
    publicAssets = path.join(root, "public");
  for (const dir of [ci, bin, scripts, publicAssets])
    fs.mkdirSync(dir, { recursive: true });
  const baycatSource =
    process.env.DESKTOP_TEST_BAYCAT ||
    path.resolve(__dirname, "../../../baycat");
  fs.copyFileSync(
    path.join(__dirname, "desktop-release.sh"),
    path.join(ci, "desktop-release.sh")
  );
  fs.copyFileSync(
    path.join(baycatSource, "scripts/release/desktop-update-manifest.js"),
    path.join(scripts, "desktop-update-manifest.js")
  );
  fs.writeFileSync(
    path.join(baycat, "package.json"),
    JSON.stringify({ version: "1.0.6" })
  );
  fs.writeFileSync(path.join(scripts, "resolve-release-platforms.js"), "");
  fs.writeFileSync(
    path.join(scripts, "format-release-notes.js"),
    'console.log("notes");'
  );
  fs.writeFileSync(
    path.join(ci, "lib.sh"),
    `
CI_ROOT="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
GITHUB_RELEASE_REPO=example/offline
RELEASES_DIR="$DESKTOP_TEST_ROOT"
BAYCAT_DIR="$DESKTOP_TEST_ROOT/baycat"
BAYCAT_REVISION=frozen-source
WORK_ROOT="$DESKTOP_TEST_ROOT"
fail() { echo "$*" >&2; exit 1; }
require_cmd() { :; }
require_mhome_clone() { :; }
read_product_tag() { PRODUCT_CHANNEL=desktop; PRODUCT_PREFIX=aw; PRODUCT_RELEASE_TAG="$1"; }
prepare_product_sources() { :; }
cleanup_worktree() { touch "$DESKTOP_TEST_ROOT/cleaned"; }
`
  );
  fs.writeFileSync(
    path.join(ci, "publish-desktop-update.sh"),
    'touch "$DESKTOP_TEST_ROOT/promoted"\n'
  );
  fs.writeFileSync(
    path.join(bin, "git"),
    '#!/bin/sh\nprintf "%s\\n" "2026-10-09T00:00:00Z"\n',
    { mode: 0o755 }
  );
  fs.writeFileSync(
    path.join(bin, "gh"),
    `#!${process.execPath}\n
const fs = require("node:fs"), path = require("node:path");
const args = process.argv.slice(2);
if (args[1] === "view") {
  if (process.env.DESKTOP_TEST_LOOKUP_ERROR) { console.error(process.env.DESKTOP_TEST_LOOKUP_ERROR); process.exit(1); }
  console.log(process.env.DESKTOP_TEST_DRAFT);
} else if (args[1] === "download") {
  fs.cpSync(path.join(process.env.DESKTOP_TEST_ROOT, "public"), args[args.indexOf("--dir") + 1], { recursive: true });
} else process.exit(1);
`,
    { mode: 0o755 }
  );
  fs.writeFileSync(
    path.join(publicAssets, "latest.json"),
    JSON.stringify({
      version,
      notes: "original notes",
      pub_date: "2026-10-09T00:00:00Z",
      platforms: {
        "windows-x86_64": {
          signature: "original signature",
          url: "https://github.com/example/offline/releases/download/aw20261009-01/MeowLink.exe",
        },
      },
    })
  );
  fs.writeFileSync(
    path.join(publicAssets, "release-source-provenance.json"),
    JSON.stringify({ baycat: { revision } })
  );
  const result = spawnSync("bash", [path.join(ci, "desktop-release.sh")], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      DESKTOP_TEST_ROOT: root,
      DESKTOP_TEST_LOOKUP_ERROR: lookupError || "",
      DESKTOP_TEST_DRAFT: String(draft),
      SSL_COM_USERNAME: "",
      SSL_COM_PASSWORD: "",
      SSL_COM_CREDENTIAL_ID: "",
      SSL_COM_TOTP_SECRET: "",
      TAURI_SIGNING_PRIVATE_KEY: "",
      RELEASE_TAG: "aw20261009-01",
      DESKTOP_PUBLISH_ROLE_ARN: "offline-role",
    },
  });
  return {
    result,
    promoted: fs.existsSync(path.join(root, "promoted")),
    cleaned: fs.existsSync(path.join(root, "cleaned")),
  };
}

test("a public Windows release resumes promotion without rebuilding signed packages", (t) => {
  const { result, promoted, cleaned } = resume(t);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(promoted, true);
  assert.equal(cleaned, true);
});
test("public retry rejects a changed source snapshot or desktop version", (t) => {
  for (const options of [
    { revision: "different-source" },
    { version: "1.0.5" },
  ]) {
    const { result, promoted, cleaned } = resume(t, options);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /does not match/);
    assert.equal(promoted, false);
    assert.equal(cleaned, true);
  }
});
test("a failed release lookup stops instead of rebuilding or promoting", (t) => {
  const { result, promoted, cleaned } = resume(t, {
    lookupError: "HTTP 403 Forbidden",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Cannot inspect existing desktop release/);
  assert.equal(promoted, false);
  assert.equal(cleaned, true);
});

test("a Windows draft still requires signing credentials before compiling", (t) => {
  const { result, promoted, cleaned } = resume(t, { draft: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Missing SSL_COM_USERNAME/);
  assert.equal(promoted, false);
  assert.equal(cleaned, true);
});
