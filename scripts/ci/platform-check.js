"use strict";

// Optional platform checks of a fixed Dev profile. No publication or profile writes.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { parseArgs } = require("node:util");
const { prepareReleaseSources } = require("./prepare-release-sources");
const { preparePluginSources } = require("./prepare-plugin-sources");
const { cleanupReleaseSources } = require("./cleanup-release-sources");

const TARGETS = {
  "linux-arm64": "aarch64-unknown-linux-gnu",
  "linux-x64": "x86_64-unknown-linux-gnu",
};

function validateProfile(profile) {
  const keys = (value, expected) => value && typeof value === "object" &&
    !Array.isArray(value) && Object.keys(value).sort().join() === expected.sort().join();
  if (!keys(profile, ["schemaVersion", "roots"]) || profile.schemaVersion !== 1 ||
      !keys(profile.roots, ["baycat", "integration"])) throw new Error("Invalid fixed Dev source profile");
  for (const pin of Object.values(profile.roots)) {
    if (!keys(pin, ["tag", "commit"]) || typeof pin.tag !== "string" ||
        !/^t\d{8}-\d{2}$/.test(pin.tag) || typeof pin.commit !== "string" ||
        !/^[a-f0-9]{40}$/.test(pin.commit)) throw new Error("Each root requires a verified t tag and full commit SHA");
  }
  return profile;
}

function runChecks({ profile, platform, workId, home = os.homedir(), run = execFileSync, onPrepared = () => {} }) {
  validateProfile(profile);
  if (!Object.hasOwn(TARGETS, platform)) {
    throw new Error(`Platform ${platform} is not supported by this check; Windows has no configured runner/full Plugin gate and is not verified`);
  }
  if (!/^platform-check-[a-zA-Z0-9_-]+$/.test(workId || "")) throw new Error("Invalid platform check work identity");
  const work = path.join(home, ".mhome/work", workId);
  fs.mkdirSync(path.dirname(work), { recursive: true });
  fs.mkdirSync(work); // Own this directory exclusively; never clean another run.
  try {
    onPrepared(work);
    const sources = prepareReleaseSources({
      version: profile.roots.baycat.tag.slice(1), expectedRevision: profile.roots.baycat.commit, workId, home,
    });
    const plugins = preparePluginSources({
      tag: profile.roots.integration.tag, expectedRevision: profile.roots.integration.commit, workId, home,
    });
    for (const [name, actual] of [["baycat", sources.baycat_revision], ["integration", plugins.plugin_revision]]) {
      const pin = profile.roots[name];
      if (actual !== pin.commit) throw new Error(`${name} ${pin.tag} is ${actual}, profile requires ${pin.commit}`);
      console.log(`Checking ${platform}: ${name} ${pin.tag} at ${actual}`);
    }
    const check = (command, args, cwd) => run(command, args, { cwd, stdio: "inherit" });
    check("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], sources.baycat_dir);
    const directory = path.join(sources.baycat_dir, "scripts/release/linux");
    const tests = fs.readdirSync(directory).filter((name) => name.endsWith(".test.js")).sort();
    if (!tests.length) throw new Error("Pinned Baycat has no Linux packaging helper tests");
    check(process.execPath, ["--test", ...tests.map((name) => path.join(directory, name))], sources.baycat_dir);
    check("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], plugins.plugin_dir);
    check("bash", ["scripts/release/quality-gate.sh", "--expect-target", TARGETS[platform]], plugins.plugin_dir);
    return { platform, profile, core: sources.meowcore_dir && JSON.parse(
      fs.readFileSync(path.join(sources.baycat_dir, "release/sources/dependencies.json"), "utf8")
    ).sources.meowcoreRust.commit, agent: sources.agent_revision };
  } finally {
    cleanupReleaseSources(work, home);
  }
}

if (require.main === module) {
  try {
    const { values } = parseArgs({ options: { event: { type: "string" }, "work-id": { type: "string" } } });
    const inputs = JSON.parse(fs.readFileSync(values.event, "utf8")).inputs;
    const result = runChecks({ profile: JSON.parse(inputs.sources), platform: inputs.platform, workId: values["work-id"],
      onPrepared: (work) => { if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `source-root=${work}\n`); },
    });
    const summary = `Platform checks passed (not a release or system E2E):\n\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\`\n`;
    console.log(summary);
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { validateProfile, runChecks };
