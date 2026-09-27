const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { parseArgs } = require("node:util");
const { PRODUCT_REPOS, canonicalClonePath, releaseWorkRoot, productSourceTag } = require("./mhome-root");
const { fetchTag, requireExistingClone, printOutputs } = require("./prepare-release-sources");

function preparePluginSources({ version, workId, home = os.homedir() }) {
  const clone = canonicalClonePath("plugin", home);
  requireExistingClone(PRODUCT_REPOS.plugin, clone);
  const tag = productSourceTag(version);
  const revision = fetchTag(clone, tag);
  const directory = path.join(releaseWorkRoot(workId, home), "plugin");
  if (fs.existsSync(directory)) throw new Error(`Refusing existing plugin worktree: ${directory}`);
  fs.mkdirSync(path.dirname(directory), { recursive: true });
  execFileSync("git", ["-C", clone, "worktree", "add", "--detach", directory, revision]);
  const packageFile = JSON.parse(fs.readFileSync(path.join(directory, "package.json")));
  if (packageFile.version !== version) throw new Error("Plugin source package version does not match the frozen tag");
  return { plugin_dir: directory, plugin_revision: revision, source_tag: tag };
}
if (require.main === module) {
  try {
    const { values } = parseArgs({ options: { version: { type: "string" }, "work-id": { type: "string" } } });
    printOutputs(preparePluginSources({ version: values.version, workId: values["work-id"] }));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { preparePluginSources };
