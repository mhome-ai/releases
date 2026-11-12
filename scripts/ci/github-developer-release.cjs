const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { shouldSkipUpload } = require("./github-release-asset-match");

const REPO = "mhome-ai/releases";
const BASE = `https://github.com/${REPO}`;
const assetUrl = (tag, name) => `${BASE}/releases/download/${tag}/${name}`;
const run = (name, args, options) => execFileSync(name, args, {
  encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 300000, ...options,
}).trim();

function releaseAssets({ tag, commit, title, notes, files, publish }, command = run) {
  if (!/^(?:kit-(?:ui|extension|wave)-v\d+\.\d+\.\d+|sdk-plugin-v\d+\.\d+\.\d+-plan-[a-f0-9]{64})$/.test(tag)
      || !/^[a-f0-9]{40}$/.test(commit)) throw new Error("Invalid developer release identity");
  const env = { ...process.env };
  for (const name of ["CARGO_REGISTRY_TOKEN", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN", "ACTIONS_ID_TOKEN_REQUEST_TOKEN", "ACTIONS_ID_TOKEN_REQUEST_URL",
    "RUNTIME_CATALOG_PRIVATE_KEY_B64"]) delete env[name];
  const options = { env, stdio: ["ignore", "pipe", "pipe"], timeout: 300000 };
  const gh = args => command("gh", [...args, "--repo", REPO], options);
  const readTag = () => {
    const ref = `refs/tags/${tag}`;
    const rows = command("git", ["ls-remote", `${BASE}.git`, ref, `${ref}^{}`], options);
    const refs = new Map(rows.split("\n").filter(Boolean).map(row => {
      const [sha, name] = row.split("\t");
      return [name, sha];
    }));
    const resolved = refs.get(`${ref}^{}`) ?? refs.get(ref);
    if (resolved && resolved !== commit) throw new Error(`Developer release tag ${tag} points to a different commit`);
    return resolved;
  };
  function read() {
    let release;
    try {
      release = JSON.parse(gh(["release", "view", tag, "--json", "tagName,targetCommitish,isDraft,assets,url"]));
    } catch (error) {
      if (String(error.stderr ?? "").trim() === "release not found") return undefined;
      throw error;
    }
    if (release.tagName !== tag || !Array.isArray(release.assets) || typeof release.isDraft !== "boolean")
      throw new Error("Invalid developer release response");
    // Draft creation may not create the tag until publication.
    if (release.isDraft && release.targetCommitish !== commit)
      throw new Error(`Developer release ${tag} has a different source commit`);
    return release;
  }
  function write(args) {
    try { gh(args); }
    catch (error) {
      // A lost response is reconciled by reads. Never repeat an uncertain write.
      const observed = read();
      if (observed) return { observed, error };
      throw error;
    }
    const observed = read();
    if (!observed) throw new Error(`Developer release ${tag} is not readable after the write`);
    return { observed };
  }
  function match(release, file) {
    const asset = release.assets.find(item => item.name === path.basename(file.path));
    if (asset && !(shouldSkipUpload(asset, `sha256:${file.sha256}`) && asset.size === file.size))
      throw new Error(`Immutable GitHub release asset differs: ${asset.name}`);
    return Boolean(asset);
  }
  let release = read();
  const tagged = readTag();
  if (release && !release.isDraft && !tagged)
    throw new Error(`Public developer release ${tag} has no verified tag`);
  if (!release) {
    release = write(["release", "create", tag, "--target", commit, "--draft", "--latest=false",
      "--title", title, "--notes", notes]).observed;
    if (!release.isDraft) throw new Error(`Expected a draft developer release: ${tag}`);
  }
  for (const file of files) {
    if (match(release, file)) continue;
    if (!release.isDraft) throw new Error(`Public release is missing ${path.basename(file.path)}`);
    const { observed, error } = write(["release", "upload", tag, file.path]);
    release = observed;
    if (!match(release, file)) throw error ?? new Error("GitHub release upload was not verified");
  }
  if (publish && release.isDraft) {
    readTag();
    const { observed, error } = write(["release", "edit", tag, "--draft=false", "--latest=false"]);
    release = observed;
    if (release.isDraft) throw error ?? new Error("GitHub release is still a draft");
    if (!readTag()) throw new Error(`Public developer release ${tag} has no verified tag`);
  }
  if (files.some(file => !match(release, file))) throw new Error("GitHub release assets changed");
  return release;
}

module.exports = { assetUrl, releaseAssets };
