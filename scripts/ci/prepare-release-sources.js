"use strict";

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { parseArgs } = require("node:util");
const {
  PRODUCT_REPOS,
  canonicalClonePath,
  mhomeRoot,
  productSourceTag,
  releaseWorkRoot,
} = require("./mhome-root");

function fail(message) {
  throw new Error(message);
}

function git(repoDir, args) {
  const result = spawnSync("git", repoDir ? ["-C", repoDir, ...args] : args, {
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const location = repoDir || args[args.length - 1];
    fail(
      `git ${args.join(" ")} failed in ${location}: ${(result.stderr || "").trim()}`
    );
  }
  return result.stdout.trim();
}

function githubRepoFromRemoteUrl(url) {
  const trimmed = String(url || "").trim().replace(/\.git$/, "").replace(/\/$/, "");
  const ssh = /^git@github\.com:(.+)$/.exec(trimmed);
  if (ssh) return ssh[1];
  const https = /^https:\/\/github\.com\/(.+)$/.exec(trimmed);
  return https ? https[1] : null;
}

function requireExistingClone(entry, repoDir) {
  if (!fs.existsSync(repoDir) || !fs.existsSync(path.join(repoDir, ".git"))) {
    fail(
      `runner is missing ${repoDir}; provision ~/.mhome/${entry.name} on this machine`
    );
  }
  const origin = git(repoDir, ["remote", "get-url", "origin"]);
  const actual = githubRepoFromRemoteUrl(origin);
  if (actual && actual !== entry.repository) {
    fail(
      `source ${entry.name} origin is ${actual}, expected ${entry.repository}`
    );
  }
}

function parseLsRemote(output) {
  return String(output || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [sha, ref] = line.split(/[\t ]+/);
      return { sha, ref };
    });
}

function fetchTag(repoDir, tag) {
  const remoteLines = git(repoDir, [
    "ls-remote",
    "origin",
    `refs/tags/${tag}`,
    `refs/tags/${tag}^{}`,
    `refs/heads/${tag}`,
  ]);
  const remoteRefs = parseLsRemote(remoteLines);
  if (remoteRefs.some((entry) => entry.ref === `refs/heads/${tag}`)) {
    fail(`ref ${tag} is a branch on origin; product sources must be tags`);
  }
  const peeled = remoteRefs.find((entry) => entry.ref?.endsWith("^{}"));
  const tagged = remoteRefs.find((entry) => entry.ref === `refs/tags/${tag}`);
  if (!tagged) {
    fail(`remote tag ${tag} not found in ${repoDir}`);
  }
  if (!peeled) {
    fail(`tag ${tag} must be annotated, not a lightweight tag`);
  }
  git(repoDir, ["fetch", "--prune", "origin"]);
  git(repoDir, ["fetch", "origin", `refs/tags/${tag}:refs/tags/${tag}`]);
  const local = git(repoDir, ["rev-parse", `${tag}^{commit}`]);
  if (local !== peeled.sha) {
    fail(
      `tag ${tag} local commit ${local} does not match origin ${peeled.sha}`
    );
  }
  return local;
}

function addDetachedWorktree(repoDir, destination, tag) {
  if (fs.existsSync(destination)) {
    fail(`refusing to overwrite existing release worktree: ${destination}`);
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  git(repoDir, ["worktree", "add", "--detach", destination, tag]);
}

function readMeowcorePin(baycatDir) {
  const dependenciesPath = path.join(
    baycatDir,
    "release/sources/dependencies.json"
  );
  const dependencies = JSON.parse(fs.readFileSync(dependenciesPath, "utf8"));
  const pin = dependencies.sources?.meowcoreRust;
  if (!pin?.version || !pin.commit) {
    fail("baycat release/sources/dependencies.json is missing meowcoreRust");
  }
  if (!/^[0-9a-f]{40}$/.test(pin.commit)) {
    fail("meowcoreRust.commit must be a full 40-character SHA");
  }
  return {
    tag: productSourceTag(pin.version),
    commit: pin.commit,
    version: pin.version,
  };
}

function requireCleanWorktree(name, directory) {
  if (!fs.existsSync(path.join(directory, ".git"))) {
    fail(`${name} is not a Git checkout: ${directory}`);
  }
  const status = git(directory, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]);
  if (status) {
    fail(`${name} has tracked, staged, or untracked changes: ${directory}`);
  }
}

function verifyProductPins({
  version,
  baycatDir,
  pallasDir,
  meowcoreDir,
  baycatVersionMode = "match",
}) {
  requireCleanWorktree("baycat", baycatDir);
  if (baycatVersionMode === "match") {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(baycatDir, "package.json"), "utf8")
    );
    if (pkg.version !== version) {
      fail(
        `baycat package.json version ${pkg.version} does not match ${version}`
      );
    }
  }
  const sourceTag = productSourceTag(version);
  const baycatHead = git(baycatDir, ["rev-parse", "HEAD"]);
  const baycatTag = git(baycatDir, ["rev-parse", `${sourceTag}^{commit}`]);
  if (baycatHead !== baycatTag) {
    fail(`baycat HEAD ${baycatHead} is not tag ${sourceTag}`);
  }
  if (pallasDir) {
    requireCleanWorktree("pallas-cat", pallasDir);
    const head = git(pallasDir, ["rev-parse", "HEAD"]);
    const tagged = git(pallasDir, ["rev-parse", `${sourceTag}^{commit}`]);
    if (head !== tagged) {
      fail(`pallas-cat HEAD ${head} is not tag ${sourceTag}`);
    }
  }
  if (meowcoreDir) {
    requireCleanWorktree("meowcore-rust", meowcoreDir);
    const pin = readMeowcorePin(baycatDir);
    const head = git(meowcoreDir, ["rev-parse", "HEAD"]);
    if (head !== pin.commit) {
      fail(
        `meowcore-rust HEAD ${head} does not match dependencies.json ${pin.commit}`
      );
    }
  }
}

function writeProvenance({
  version,
  baycatDir,
  pallasDir,
  meowcoreDir,
  workId,
  workflowRunUrl,
  runAttempt,
}) {
  const revision = (directory) =>
    directory ? git(directory, ["rev-parse", "HEAD"]) : null;
  const pin = meowcoreDir ? readMeowcorePin(baycatDir) : null;
  const payload = {
    schemaVersion: 1,
    kind: "meow.release-source-provenance",
    version,
    workId,
    workflowRun: workflowRunUrl || null,
    runAttempt: runAttempt || null,
    baycat: {
      repository: PRODUCT_REPOS.baycat.repository,
      tag: productSourceTag(version),
      revision: revision(baycatDir),
    },
    pallasCat: pallasDir
      ? {
          repository: PRODUCT_REPOS["pallas-cat"].repository,
          tag: productSourceTag(version),
          revision: revision(pallasDir),
        }
      : null,
    meowcoreRust: meowcoreDir
      ? {
          repository: PRODUCT_REPOS["meowcore-rust"].repository,
          tag: pin.tag,
          revision: revision(meowcoreDir),
        }
      : null,
  };
  const buildDir = path.join(baycatDir, "build");
  fs.mkdirSync(buildDir, { recursive: true });
  const file = path.join(buildDir, "release-source-provenance.json");
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`);
  return payload;
}

function prepareReleaseSources({
  version,
  workId,
  withMeowcore = true,
  withPallas = false,
  baycatVersionMode = "match",
  home = os.homedir(),
  workflowRunUrl = process.env.GITHUB_SERVER_URL &&
    process.env.GITHUB_REPOSITORY &&
    process.env.GITHUB_RUN_ID
    ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
    : "",
  runAttempt = process.env.GITHUB_RUN_ATTEMPT || "",
} = {}) {
  const sourceTag = productSourceTag(version);
  const workRoot = releaseWorkRoot(workId, home);
  const baycatClone = canonicalClonePath("baycat", home);
  const meowcoreClone = canonicalClonePath("meowcore-rust", home);
  const pallasClone = canonicalClonePath("pallas-cat", home);
  const baycatDir = path.join(workRoot, "baycat");
  const meowcoreDir = withMeowcore ? path.join(workRoot, "meowcore-rust") : "";
  const pallasDir = withPallas ? path.join(workRoot, "pallas-cat") : "";

  requireExistingClone(PRODUCT_REPOS.baycat, baycatClone);
  fetchTag(baycatClone, sourceTag);
  addDetachedWorktree(baycatClone, baycatDir, sourceTag);

  if (withPallas) {
    requireExistingClone(PRODUCT_REPOS["pallas-cat"], pallasClone);
    fetchTag(pallasClone, sourceTag);
    addDetachedWorktree(pallasClone, pallasDir, sourceTag);
  }

  if (withMeowcore) {
    const pin = readMeowcorePin(baycatDir);
    requireExistingClone(PRODUCT_REPOS["meowcore-rust"], meowcoreClone);
    const meowcoreCommit = fetchTag(meowcoreClone, pin.tag);
    if (meowcoreCommit !== pin.commit) {
      fail(
        `meowcore-rust ${pin.tag} is ${meowcoreCommit}, dependencies.json requires ${pin.commit}`
      );
    }
    addDetachedWorktree(meowcoreClone, meowcoreDir, pin.tag);
  }

  verifyProductPins({
    version,
    baycatDir,
    pallasDir: pallasDir || undefined,
    meowcoreDir: meowcoreDir || undefined,
    baycatVersionMode,
  });
  const provenance = writeProvenance({
    version,
    baycatDir,
    pallasDir: pallasDir || undefined,
    meowcoreDir: meowcoreDir || undefined,
    workId,
    workflowRunUrl,
    runAttempt,
  });

  return {
    source_root: workRoot,
    baycat_dir: baycatDir,
    baycat_revision: provenance.baycat.revision,
    meowcore_dir: meowcoreDir || "",
    pallas_dir: pallasDir || "",
    source_tag: sourceTag,
    mhome_root: mhomeRoot(home),
  };
}

function writeGithubOutput(outputs) {
  const file = process.env.GITHUB_OUTPUT;
  const body = Object.entries(outputs)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  if (file) fs.appendFileSync(file, `${body}\n`);
  else process.stdout.write(`${body}\n`);
}

if (require.main === module) {
  try {
    const { values } = parseArgs({
      options: {
        version: { type: "string" },
        "work-id": { type: "string" },
        "with-meowcore": { type: "boolean", default: false },
        "with-pallas": { type: "boolean", default: false },
        "baycat-version-mode": { type: "string", default: "match" },
      },
    });
    const workId =
      values["work-id"] ||
      [
        process.env.GITHUB_RUN_ID,
        process.env.GITHUB_JOB,
        process.env.GITHUB_RUN_ATTEMPT,
      ]
        .filter(Boolean)
        .join("-");
    if (!values.version || !workId) {
      fail("--version and --work-id are required");
    }
    const outputs = prepareReleaseSources({
      version: values.version,
      workId,
      withMeowcore: values["with-meowcore"],
      withPallas: values["with-pallas"],
      baycatVersionMode: values["baycat-version-mode"],
    });
    writeGithubOutput(outputs);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = {
  fetchTag,
  prepareReleaseSources,
  readMeowcorePin,
  requireExistingClone,
};
