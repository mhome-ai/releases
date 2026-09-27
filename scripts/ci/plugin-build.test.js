const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { verifyHandoff } = require('./verify-plugin-handoff');

for (const failQuality of [false, true]) test(`build cleanup preserves the publisher workspace (quality failure: ${failQuality})`, async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-build-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const mhome = path.join(temp, '.mhome');
  const work = path.join(mhome, 'work', 'fixture');
  const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
  function init(directory) {
    fs.mkdirSync(directory, { recursive: true });
    git(directory, 'init', '-b', 'main');
    git(directory, 'config', 'user.name', 'Fixture');
    git(directory, 'config', 'user.email', 'fixture@example.invalid');
  }
  const source = path.join(temp, 'origin');
  init(source);
  const files = {
    'package.json': JSON.stringify({ name: 'plugin-fixture', version: '1.0.5' }),
    'package-lock.json': JSON.stringify({ name: 'plugin-fixture', version: '1.0.5', lockfileVersion: 3, packages: { '': { name: 'plugin-fixture', version: '1.0.5' } } }),
    'scripts/release/quality-gate.sh': `exit ${failQuality ? 1 : 0}\n`,
    'scripts/release/native/package.js': `const fs = require('fs'); const dir = process.argv[process.argv.indexOf('--output') + 1]; fs.writeFileSync(dir + '/fixture.tar.gz', 'build result');`,
  };
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(source, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  git(source, 'add', '.');
  git(source, 'commit', '-m', 'source');
  git(source, 'tag', '-a', 'v1.0.5', '-m', 'source freeze');
  fs.mkdirSync(mhome, { recursive: true });
  git(temp, 'clone', source, path.join(mhome, 'plugin'));
  const orchestrator = path.join(work, 'releases');
  init(orchestrator);
  git(orchestrator, 'commit', '--allow-empty', '-m', 'orchestrator');
  const bin = path.join(temp, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'curl'), '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do if [ "$1" = --output ]; then shift; printf missing > "$1"; fi; shift; done\nprintf 404\n', { mode: 0o755 });
  // Production resolves ~/.mhome; inject a fixture homedir without changing HOME.
  const homeOverride = path.join(temp, 'fixture-home.cjs');
  fs.writeFileSync(homeOverride, `require('node:os').homedir = () => ${JSON.stringify(temp)};`);
  const handoff = path.join(temp, 'handoff');
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, NODE_OPTIONS: `--require=${homeOverride}`,
    MHOME_ROOT: mhome, WORK_ROOT: work, WORK_ID: 'fixture', RELEASES_DIR: orchestrator,
    RELEASE_TAG: 'pnmr1.0.5', WORK_SUFFIX: 'darwin-arm64', PLUGIN_HANDOFF: handoff, INITIALIZE_CATALOG: 'true' };
  for (const key of ['PLUGIN_CATALOG_PRIVATE_KEY_B64', 'APPLE_CSC_LINK', 'APPLE_CSC_KEY_PASSWORD', 'AWS_SECRET_ACCESS_KEY']) delete env[key];
  const result = spawnSync('bash', [path.join(__dirname, 'plugin-build.sh')], { env, encoding: 'utf8' });
  assert.equal(result.status, failQuality ? 1 : 0, result.stderr + result.stdout);
  assert.equal(fs.existsSync(path.join(work, 'plugin')), false);
  assert.equal(fs.existsSync(path.join(orchestrator, '.git')), true);
  assert.equal(git(path.join(mhome, 'plugin'), 'worktree', 'list', '--porcelain').match(/^worktree /gm).length, 1);
  if (!failQuality) await verifyHandoff(handoff, git(source, 'rev-parse', 'HEAD'), git(orchestrator, 'rev-parse', 'HEAD'), 'pnmr1.0.5');
});
