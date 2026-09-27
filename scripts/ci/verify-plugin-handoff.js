const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

async function artifactDigests(directory) {
  const digests = {};
  async function walk(relative = '') {
    for (const entry of fs.readdirSync(path.join(directory, relative), { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name))) {
      const file = path.posix.join(relative, entry.name);
      if (file === 'build.json') continue;
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile()) {
        const hash = crypto.createHash('sha256');
        for await (const chunk of fs.createReadStream(path.join(directory, file))) hash.update(chunk);
        digests[file] = hash.digest('hex');
      } else throw new Error(`Unsupported handoff entry: ${file}`);
    }
  }
  await walk();
  return digests;
}
async function writeHandoff(directory, source, orchestrator, tag) {
  const artifacts = await artifactDigests(directory);
  fs.writeFileSync(path.join(directory, 'build.json'), JSON.stringify({source, orchestrator, tag, artifacts}));
}
async function verifyHandoff(directory, source, orchestrator, tag) {
  const record = JSON.parse(fs.readFileSync(path.join(directory,'build.json')));
  if (record.source !== source || record.orchestrator !== orchestrator || record.tag !== tag)
    throw new Error('Plugin artifact belongs to a different source, orchestrator or release tag');
  if (JSON.stringify(record.artifacts) !== JSON.stringify(await artifactDigests(directory)))
    throw new Error('Plugin handoff artifacts changed after the build');
}
module.exports = { verifyHandoff, writeHandoff };
if (require.main === module) {
  const args = process.argv.slice(2);
  const operation = args[0] === '--write' ? (args.shift(), writeHandoff) : verifyHandoff;
  operation(...args).catch(error => { console.error(error.message); process.exitCode = 1; });
}
