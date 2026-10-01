const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { parseArgs } = require("node:util");
const {
  PRODUCT_REPOS,
  canonicalClonePath,
  releaseWorkRoot,
} = require("./mhome-root");
const {
  fetchTag,
  requireExistingClone,
  printOutputs,
} = require("./prepare-release-sources");

function preparePluginSources({ version, tag, workId, home = os.homedir() }) {
  if (!/^t\d{8}-\d{2}$/.test(tag || "")) {
    throw new Error("Plugin source tag must be tYYYYMMDD-NN");
  }
  const clone = canonicalClonePath("plugin", home);
  requireExistingClone(PRODUCT_REPOS.plugin, clone);
  const revision = fetchTag(clone, tag);
  require("./verify-plugin-source").verifyPluginSource(clone, revision);
  const directory = path.join(releaseWorkRoot(workId, home), "plugin");
  if (fs.existsSync(directory))
    throw new Error(`Refusing existing plugin worktree: ${directory}`);
  fs.mkdirSync(path.dirname(directory), { recursive: true });
  execFileSync("git", [
    "-C",
    clone,
    "worktree",
    "add",
    "--detach",
    directory,
    revision,
  ]);
  void version;
  return { plugin_dir: directory, plugin_revision: revision, source_tag: tag };
}
if (require.main === module) {
  try {
    const { values } = parseArgs({
      options: {
        version: { type: "string" },
        tag: { type: "string" },
        "work-id": { type: "string" },
      },
    });
    printOutputs(
      preparePluginSources({
        version: values.version,
        tag: values.tag,
        workId: values["work-id"],
      })
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
module.exports = { preparePluginSources };
