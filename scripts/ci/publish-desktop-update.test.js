const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

// The real promotion script and manifest helper run against isolated executable
// fixtures; no GitHub, AWS or public download is contacted.
const fake = String.raw`
const fs = require("node:fs"), path = require("node:path");
const args = process.argv.slice(2), tool = path.basename(process.argv[1]);
const stateFile = process.env.DESKTOP_TEST_STATE;
const s = JSON.parse(fs.readFileSync(stateFile));
s.calls.push([tool, ...args]);
const save = () => fs.writeFileSync(stateFile, JSON.stringify(s));
const fail = message => { save(); console.error(message); process.exit(1); };
const option = flag => args[args.indexOf(flag) + 1];
if (tool === "gh") {
  console.log(s.draft ? "true" : "false");
} else if (tool === "curl") {
  const url = args.find(a => a.startsWith("https://"));
  if (url.startsWith("https://oidc.invalid/")) console.log(JSON.stringify({ value: "offline-token" }));
  else {
    let content;
    if (url.endsWith("/" + s.tag + "/latest.json")) content = s.failure === "manifest" ? "invalid" : s.manifest;
    else if (url.startsWith("https://install.mhome.ai/")) {
      const key = url.slice("https://install.mhome.ai/".length);
      content = s.failure === "readback" ? "stale" : s.objects[key];
    } else {
      const name = new URL(url).pathname.split("/").pop();
      if (!(name in s.packages)) fail("unexpected download: " + url);
      content = s.failure === "package" ? "corrupt" : s.packages[name];
    }
    if (content === undefined) fail("missing public object: " + url);
    fs.writeFileSync(option("-o"), content);
  }
} else if (tool === "aws") {
  if (args[0] === "sts") console.log("offline-access offline-secret offline-session");
  else if (args[0] === "s3api" && args[1] === "head-object") {
    if (s.failure === "head") fail("403 AccessDenied");
    if (!(option("--key") in s.objects)) fail("404 Not Found");
  } else if (args[0] === "s3" && args[1] === "cp") {
    if (args[2].startsWith("s3://")) {
      const key = args[2].split("/").slice(3).join("/");
      if (!(key in s.objects)) fail("missing stored object");
      fs.writeFileSync(args[3], s.objects[key]);
    } else {
      if (s.failure === "put") fail("injected PUT failure");
      const key = args[3].split("/").slice(3).join("/");
      s.objects[key] = fs.readFileSync(args[2], "utf8");
      if (!args.includes("--cache-control")) fail("missing cache policy");
    }
  } else fail("unexpected AWS call");
} else fail("unexpected tool");
save();
`;

function manifest(version, tag) {
  const targets = tag.startsWith("am")
    ? ["darwin-aarch64", "darwin-x86_64"]
    : ["windows-x86_64"];
  return {
    version,
    notes: `${tag} notes`,
    pub_date: "2026-10-09T00:00:00.000Z",
    platforms: Object.fromEntries(
      targets.map((target) => [
        target,
        {
          signature: `signature-${target}`,
          url: `https://github.com/example/offline/releases/download/${tag}/MeowLink-${target}${
            target.startsWith("darwin") ? ".app.tar.gz" : ".exe"
          }`,
        },
      ])
    ),
  };
}
function feeds(m) {
  return Object.fromEntries(
    Object.keys(m.platforms).map((target) => [
      `desktop/stable/${target}/latest.json`,
      JSON.stringify(
        { ...m, platforms: { [target]: m.platforms[target] } },
        null,
        2
      ) + "\n",
    ])
  );
}
function run(
  t,
  {
    tag = "am20261009-01",
    version = "1.2.8",
    objects = {},
    failure,
    draft = false,
  } = {}
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "desktop feed test "));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, "bin"),
    artifacts = path.join(root, "artifacts");
  fs.mkdirSync(bin);
  fs.mkdirSync(artifacts);
  for (const tool of ["gh", "curl", "aws"])
    fs.writeFileSync(path.join(bin, tool), `#!${process.execPath}\n${fake}`, {
      mode: 0o755,
    });
  const m = manifest(version, tag),
    packages = {};
  const bytes = JSON.stringify(m, null, 2) + "\n";
  fs.writeFileSync(path.join(artifacts, "latest.json"), bytes);
  for (const entry of Object.values(m.platforms)) {
    const name = new URL(entry.url).pathname.split("/").pop();
    packages[name] = `package-${name}`;
    fs.writeFileSync(path.join(artifacts, name), packages[name]);
  }
  const stateFile = path.join(root, "state.json");
  fs.writeFileSync(
    stateFile,
    JSON.stringify({
      tag,
      manifest: bytes,
      packages,
      objects,
      failure,
      draft,
      calls: [],
    })
  );
  const baycat =
    process.env.DESKTOP_TEST_BAYCAT ||
    path.resolve(__dirname, "../../../baycat");
  const result = spawnSync(
    "bash",
    [
      path.join(__dirname, "publish-desktop-update.sh"),
      "example/offline",
      tag,
      artifacts,
      baycat,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}${path.delimiter}${process.env.PATH}`,
        DESKTOP_TEST_STATE: stateFile,
        DESKTOP_PUBLISH_ROLE_ARN: "offline-role",
        ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.invalid/token?request=1",
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: "offline-token",
      },
    }
  );
  return {
    result,
    state: JSON.parse(fs.readFileSync(stateFile)),
    expected: feeds(m),
  };
}
const puts = (s) =>
  s.calls.filter(
    (a) =>
      a[0] === "aws" &&
      a[1] === "s3" &&
      a[2] === "cp" &&
      !a[3].startsWith("s3://")
  );

test("Mac promotion leaves a differently versioned Windows feed byte-for-byte unchanged", (t) => {
  const windows = feeds(manifest("1.1.9", "aw20261008-01"));
  const { result, state, expected } = run(t, { objects: windows });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(state.objects, { ...windows, ...expected });
  assert.equal(puts(state).length, 2);
  const firstPut = state.calls.findIndex((a) =>
    puts(state).some((p) => p === a)
  );
  assert.equal(
    state.calls
      .slice(0, firstPut)
      .filter(
        (a) => a[0] === "curl" && a.some((arg) => arg.endsWith(".app.tar.gz"))
      ).length,
    2
  );
});
test("Windows promotion leaves both Mac feeds unchanged", (t) => {
  const mac = feeds(manifest("1.2.8", "am20261009-01"));
  const { result, state, expected } = run(t, {
    tag: "aw20261008-01",
    version: "1.1.9",
    objects: mac,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(state.objects, { ...mac, ...expected });
  assert.equal(puts(state).length, 1);
});
test("an exact retry performs no PUT and verifies the public feed", (t) => {
  const { result, state } = run(t, {
    objects: feeds(manifest("1.2.8", "am20261009-01")),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(puts(state).length, 0);
  assert.match(result.stdout, /Verified desktop update/);
});
for (const failure of ["manifest", "package", "head", "put"]) {
  test(`${failure} failure does not replace the previous feeds`, (t) => {
    const previous = feeds(manifest("1.2.7", "am20261008-01"));
    const { result, state } = run(t, { objects: previous, failure });
    assert.notEqual(result.status, 0);
    assert.deepEqual(state.objects, previous);
    assert.doesNotMatch(result.stdout, /Verified desktop update/);
  });
}
test("drafts and conflicting versions never promote", (t) => {
  for (const options of [
    { draft: true },
    { objects: feeds(manifest("1.2.9", "am20261010-01")) },
    { objects: feeds(manifest("1.2.8", "am20261008-01")) },
  ]) {
    const { result, state } = run(t, options);
    assert.notEqual(result.status, 0);
    assert.equal(puts(state).length, 0);
  }
});
test("a conflicting Intel feed is discovered before the ARM feed can change", (t) => {
  const previous = {
    ...feeds(manifest("1.2.7", "am20261008-01")),
    "desktop/stable/darwin-x86_64/latest.json": feeds(
      manifest("1.2.9", "am20261010-01")
    )["desktop/stable/darwin-x86_64/latest.json"],
  };
  const { result, state } = run(t, { objects: previous });
  assert.notEqual(result.status, 0);
  assert.deepEqual(state.objects, previous);
  assert.equal(puts(state).length, 0);
});
test("readback failure reports the unconfirmed rollout without reverting a successful PUT", (t) => {
  const { result, state, expected } = run(t, { failure: "readback" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /retry this release to confirm/);
  assert.equal(
    state.objects["desktop/stable/darwin-aarch64/latest.json"],
    expected["desktop/stable/darwin-aarch64/latest.json"]
  );
  assert.equal(puts(state).length, 1);
});
