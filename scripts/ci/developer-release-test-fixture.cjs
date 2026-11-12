const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { assetUrl } = require("./github-developer-release.cjs");

function githubReleases({ lost = false, denied = false, corrupt = false } = {}) {
  const releases = new Map(), tags = new Map(), calls = [];
  const command = (program, args, options) => {
    assert.equal(Object.hasOwn(options.env, "CARGO_REGISTRY_TOKEN"), false);
    if (program === "git") {
      assert.equal(args[0], "ls-remote");
      const ref = args[2], tag = ref.slice("refs/tags/".length);
      return tags.has(tag) ? `${tags.get(tag)}\t${ref}` : "";
    }
    assert.equal(program, "gh");
    assert.equal(args[0], "release");
    assert.equal(args.at(-1), "mhome-ai/releases");
    const [, action, tag] = args;
    calls.push({ action, tag });
    let release = releases.get(tag);
    if (action === "view") {
      if (denied) throw new Error("Permission denied");
      if (!release) throw Object.assign(new Error("not found"), { stderr: "release not found\n" });
      const assets = [...release.files].map(([name, bytes]) => ({
        name, size: bytes.length, state: "uploaded",
        digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      }));
      return JSON.stringify({ ...release, assets });
    }
    if (action === "create") {
      assert(!release);
      assert(args.includes("--draft") && args.includes("--latest=false"));
      release = {
        tagName: tag, isDraft: true,
        targetCommitish: args[args.indexOf("--target") + 1],
        url: `https://github.com/mhome-ai/releases/releases/tag/${tag}`, files: new Map(),
      };
      releases.set(tag, release);
    } else if (action === "upload") {
      assert(release.isDraft);
      assert(!args.includes("--clobber"));
      const name = path.basename(args[3]);
      assert(!release.files.has(name));
      release.files.set(name, corrupt ? Buffer.from("altered") : fs.readFileSync(args[3]));
      if (lost) throw new Error("upload response lost");
    } else if (action === "edit") {
      assert(release.isDraft && args.includes("--draft=false") && args.includes("--latest=false"));
      tags.set(tag, release.targetCommitish);
      release.isDraft = false;
    } else throw new Error(`Unexpected GitHub action: ${action}`);
    return "";
  };
  function publicBytes(url) {
    for (const [tag, release] of releases) {
      if (release.isDraft) continue;
      for (const [name, bytes] of release.files) if (url === assetUrl(tag, name)) return bytes;
    }
  }
  return { releases, tags, calls, command, publicBytes };
}

module.exports = { githubReleases };
