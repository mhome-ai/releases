const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function fixture(t, responses) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "release-read-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const stateFile = path.join(dir, "state.json");
  fs.writeFileSync(stateFile, JSON.stringify({ responses, calls: [], pauses: [] }));
  const script = `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path');
const file=path.join(__dirname,'state.json'),s=JSON.parse(fs.readFileSync(file));
if(path.basename(process.argv[1])==='sleep') {
 s.pauses.push(process.argv.slice(2));fs.writeFileSync(file,JSON.stringify(s));
} else {
 const r=s.responses[Math.min(s.calls.length,s.responses.length-1)];
 s.calls.push(process.argv.slice(2));fs.writeFileSync(file,JSON.stringify(s));
 process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');process.exitCode=r.status;
}
`;
  for (const name of ["gh", "sleep"]) fs.writeFileSync(path.join(dir, name), script, { mode: 0o755 });
  const run = () => spawnSync("bash", ["-c", 'source "$1"; github_release_view tag owner/repo --json assets', "bash", path.join(__dirname, "lib.sh")], {
    encoding: "utf8", env: { ...process.env, PATH: dir + path.delimiter + process.env.PATH },
  });
  return { run, state: () => JSON.parse(fs.readFileSync(stateFile)) };
}

test("a newly created draft can survive a temporarily missing tag lookup", t => {
  const f = fixture(t, [{ status: 1, stderr: "release not found\n" }, { status: 0, stdout: '{"assets":[]}' }]);
  const r = f.run();
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { assets: [] });
  assert.deepEqual(f.state().pauses, [["2"]]);
  assert.deepEqual(f.state().calls, Array(2).fill(["release", "view", "tag", "--repo", "owner/repo", "--json", "assets"]));
});

test("read failures are bounded and cannot masquerade as release absence", t => {
  const f = fixture(t, [{ status: 1, stderr: "HTTP 503: unavailable\n" }]);
  const r = f.run();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /HTTP 503/);
  assert.equal(f.state().calls.length, 3);
  assert.deepEqual(f.state().pauses, [["2"], ["4"]]);
});

test("only an explicit missing release receives the absence status", t => {
  const f = fixture(t, [{ status: 1, stderr: "release not found\n" }]);
  assert.equal(f.run().status, 4);
  assert.equal(f.state().calls.length, 3);
});

test("failed partial stdout never corrupts a later successful JSON result", t => {
  const f = fixture(t, [{ status: 1, stdout: "partial", stderr: "connection reset" }, { status: 0, stdout: '{"assets":[]}' }]);
  const r = f.run();
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { assets: [] });
});
