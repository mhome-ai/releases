const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

test("native GitHub releases never steal Desktop Latest", () => {
  const script = fs.readFileSync(
    path.join(__dirname, "native-release.sh"),
    "utf8"
  );
  assert.match(script, /gh release create/);
  assert.match(script, /--latest=false/);
  assert.match(script, /gh release edit/);
  assert.match(script, /--draft=false --latest=false/);
});
