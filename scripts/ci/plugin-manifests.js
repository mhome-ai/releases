const fs = require("node:fs");
const path = require("node:path");
const { spawnSync, execFileSync } = require("node:child_process");

// A reused version retains its original signed bytes. Re-signing it would add
// a new timestamp/signature and break immutable publication on the next run.
function prepareManifest(manifest, existing, sign, verify) {
  if (existing) {
    const bundle = JSON.parse(existing);
    if (bundle.schemaVersion !== 1 || bundle.kind !== "meow.plugin.manifest-bundle" ||
        typeof bundle.manifest !== "string" || typeof bundle.signature !== "string") {
      throw new Error("Invalid existing Plugin manifest bundle");
    }
    verify(bundle.manifest, bundle.signature);
    if (bundle.manifest !== manifest) throw new Error("Plugin manifest changed at an existing version");
    return existing;
  }
  const signature = sign(manifest);
  verify(manifest, signature);
  return `${JSON.stringify({ schemaVersion: 1, kind: "meow.plugin.manifest-bundle", manifest, signature })}\n`;
}

function main([catalogDir, bucket, publicKey, privateKey]) {
  const records = JSON.parse(fs.readFileSync(path.join(catalogDir, "manifests.json")));
  for (const record of records) {
    if (!/^plugins\/[a-z][a-z0-9-]*\/releases\/\d+\.\d+\.\d+\/(darwin|linux)-(arm64|x64)\/manifest\.bundle\.json$/.test(record.key)) {
      throw new Error("Invalid Plugin manifest publication key");
    }
    const file = path.join(catalogDir, "manifests", `${record.id}.json`);
    const old = `${file}.existing.bundle.json`;
    const read = spawnSync("aws", ["s3", "cp", `s3://${bucket}/${record.key}`, old, "--only-show-errors"], { encoding: "utf8" });
    if (read.status !== 0 && !/404|NoSuchKey|does not exist/i.test(read.stderr || "")) {
      throw new Error(`Cannot inspect existing Plugin manifest: ${read.stderr || read.error || "request failed"}`);
    }
    const output = prepareManifest(fs.readFileSync(file, "utf8"), read.status === 0 ? fs.readFileSync(old, "utf8") : null,
      (manifest) => {
        if (!privateKey || !fs.existsSync(privateKey)) throw new Error("Signing key required for a new Plugin manifest");
        fs.writeFileSync(`${file}.verify`, manifest);
        execFileSync("minisign", ["-Sm", `${file}.verify`, "-s", privateKey, "-x", `${file}.minisig`], { stdio: "pipe" });
        return fs.readFileSync(`${file}.minisig`, "utf8");
      },
      (manifest, signature) => {
        fs.writeFileSync(`${file}.verify`, manifest);
        fs.writeFileSync(`${file}.minisig`, signature);
        execFileSync("minisign", ["-Vm", `${file}.verify`, "-x", `${file}.minisig`, "-P", publicKey], { stdio: "pipe" });
      });
    fs.writeFileSync(`${file}.bundle.json`, output);
  }
}
module.exports = { prepareManifest };
if (require.main === module) main(process.argv.slice(2));
