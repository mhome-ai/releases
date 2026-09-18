const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

test("native GitHub releases never steal Desktop Latest", () => {
  const workflow = fs.readFileSync(
    path.join(__dirname, "../../.github/workflows/native-runtime-platform-release.yaml"),
    "utf8"
  );
  assert.match(workflow, /gh release create/);
  assert.match(workflow, /--latest=false/);
  assert.match(workflow, /gh release edit/);
  assert.match(workflow, /--draft=false --latest=false/);
});
