const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const installer = path.join(__dirname, "install-test-ffmpeg.sh");

function runWithInvalidArchive(architecture) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ffmpeg-installer-"));
  const executable = (name, content) => {
    fs.writeFileSync(path.join(directory, name), content, { mode: 0o755 });
  };
  try {
    executable("dpkg", `#!/bin/sh\nprintf '%s\\n' '${architecture}'\n`);
    executable("curl", `#!/bin/sh
while [ "$#" -gt 0 ]; do
  if [ "$1" = '-o' ]; then
    shift
    printf 'corrupted archive' > "$1"
    exit 0
  fi
  shift
done
exit 2
`);
    // Keep this failure-path check offline and runnable on macOS as well.
    // This implements the checksum utility interface, not the installer logic.
    executable("sha256sum", `#!/usr/bin/env python3
import hashlib, pathlib, sys
expected, filename = sys.stdin.readline().rstrip().split(None, 1)
actual = hashlib.sha256(pathlib.Path(filename).read_bytes()).hexdigest()
if actual != expected:
    print("archive checksum mismatch", file=sys.stderr)
    sys.exit(1)
`);
    for (const command of ["tar", "install"]) {
      executable(command, "#!/bin/sh\necho MUTATION_REACHED >&2\nexit 99\n");
    }
    return spawnSync("bash", [installer], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${directory}:${process.env.PATH}` },
    });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

for (const architecture of ["amd64", "arm64"]) {
  test(`${architecture}: rejects corrupt bytes before extraction or installation`, () => {
    const result = runWithInvalidArchive(architecture);
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /archive checksum mismatch/);
    assert.doesNotMatch(result.stderr, /MUTATION_REACHED/);
  });
}

test("rejects an unsupported architecture before extraction or installation", () => {
  const result = runWithInvalidArchive("riscv64");
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unsupported FFmpeg runner architecture/);
  assert.doesNotMatch(result.stderr, /MUTATION_REACHED/);
});
