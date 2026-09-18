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

function git(repoDir, args, env = process.env) {
  const result = spawnSync("git", repoDir ? ["-C", repoDir, ...args] : args, {
    encoding: "utf8",
    env: { ...env, GIT_TERMINAL_PROMPT: "0" },
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
  const https = /^https:\/\/(?:x-access-token:[^@]+@)?github\.com\/(.+)$/.exec(
    trimmed
  );
  if (https) return https[1];
  return null;
}

function defaultCloneUrl(repository, token) {
  if (token) return `https://x-access-token:${token}@github.com/${repository}.git`;
  return `git@github.com:${repository}.git`;
}

function gitEnv(token) {
  if (!token) return process.env;
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.extraHeader",
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: bearer ${token}`,
  };
}

function ensureClone(entry, repoDir, { token, cloneUrlFor }) {
  const cloneUrl = cloneUrlFor
    ? cloneUrlFor(entry)
    : defaultCloneUrl(entry.repository, token);
  if (!fs.existsSync(repoDir)) {
    fs.mkdirSync(path.dirname(repoDir), { recursive: true });
    git(null, ["clone", "--branch", entry.defaultBranch, cloneUrl, repoDir]);
    const origin = git(repoDir, ["remote", "get-url", "origin"]);
    const sanitized = origin.replace(
      /https:\/\/x-access-token:[^@]+@github\.com/i,
      "https://github.com"
    );
    if (sanitized !== origin) {
      git(repoDir, ["remote", "set-url", "origin", sanitized]);
    }
  }
  if (!fs.existsSync(path.join(repoDir, ".git"))) {
    fail(`source ${entry.name} exists at ${repoDir} but is not a git checkout`);
  }
  const origin = git(repoDir, ["remote", "get-url", "origin"]);
  const actual = githubRepoFromRemoteUrl(origin);
  if (actual && actual !== entry.repository) {
    fail(
      `source ${entry.name} origin is ${actual}, expected ${entry.repository}`
    );
  }
}

function fetchTag(repoDir, tag, token) {
  const env = gitEnv(token);
  git(repoDir, ["fetch", "--prune", "origin"], env);
  git(
    repoDir,
    ["fetch", "origin", `refs/tags/${tag}:refs/tags/${tag}`],
    env
  );
  const local = git(repoDir, ["rev-parse", `${tag}^{commit}`]);
  const remoteLines = git(
    repoDir,
    ["ls-remote", "origin", `refs/tags/${tag}`, `refs/tags/${tag}^{}`],
    env
  );
  const remoteRefs = remoteLines
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [sha, ref] = line.split(/[\t ]+/);
      return { sha, ref };
    });
  const peeled = remoteRefs.find((entry) => entry.ref?.endsWith("^{}"));
  const tagged = remoteRefs.find((entry) => entry.ref === `refs/tags/${tag}`);
  if (!peeled && !tagged) {
    fail(`remote tag ${tag} not found in ${repoDir}`);
  }
  const remoteCommit = peeled
    ? peeled.sha
    : git(repoDir, ["rev-parse", `${tagged.sha}^{commit}`], env);
  if (local !== remoteCommit) {
    fail(
      `tag ${tag} local commit ${local} does not match origin ${remoteCommit}`
    );
  }
  const branch = spawnSync(
    "git",
    ["-C", repoDir, "show-ref", "--verify", "--quiet", `refs/heads/${tag}`],
    { stdio: "ignore" }
  );
  if (branch.status === 0) {
    fail(`ref ${tag} is a branch; product sources must be tags`);
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

function verifySources({
  version,
  baycatDir,
  pallasDir,
  meowcoreDir,
  baycatVersionMode = "match",
}) {
  const script = path.join(baycatDir, "scripts/ci/ci-verify-release-sources.sh");
  const args = [
    "--version",
    version,
    "--baycat",
    baycatDir,
    "--baycat-ref",
    productSourceTag(version),
    "--baycat-version-mode",
    baycatVersionMode,
  ];
  if (pallasDir) args.push("--pallas", pallasDir);
  if (meowcoreDir) args.push("--meowcore", meowcoreDir);
  const result = spawnSync("bash", [script, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    fail(
      `ci-verify-release-sources.sh failed: ${(result.stderr || result.stdout || "").trim()}`
    );
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
  token = process.env.RELEASE_SOURCE_TOKEN || "",
  home = os.homedir(),
  cloneUrlFor,
  workflowRunUrl = process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
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

  ensureClone(PRODUCT_REPOS.baycat, baycatClone, { token, cloneUrlFor });
  fetchTag(baycatClone, sourceTag, token);
  addDetachedWorktree(baycatClone, baycatDir, sourceTag);

  if (withPallas) {
    ensureClone(PRODUCT_REPOS["pallas-cat"], pallasClone, { token, cloneUrlFor });
    fetchTag(pallasClone, sourceTag, token);
    addDetachedWorktree(pallasClone, pallasDir, sourceTag);
  }

  if (withMeowcore) {
    const pin = readMeowcorePin(baycatDir);
    ensureClone(PRODUCT_REPOS["meowcore-rust"], meowcoreClone, {
      token,
      cloneUrlFor,
    });
    const meowcoreCommit = fetchTag(meowcoreClone, pin.tag, token);
    if (meowcoreCommit !== pin.commit) {
      fail(
        `meowcore-rust ${pin.tag} is ${meowcoreCommit}, dependencies.json requires ${pin.commit}`
      );
    }
    addDetachedWorktree(meowcoreClone, meowcoreDir, pin.tag);
  }

  verifySources({
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
  defaultCloneUrl,
  fetchTag,
  prepareReleaseSources,
  readMeowcorePin,
};
