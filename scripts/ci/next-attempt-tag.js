"use strict";

const { execFileSync } = require("node:child_process");
const { parseArgs } = require("node:util");

function utcDay(date = new Date()) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}${month}${day}`;
}

function nextAttemptTag(existing, date = new Date()) {
  const day = utcDay(date);
  const pattern = new RegExp(`^t${day}-(\\d{2})$`);
  let highest = 0;
  for (const tag of existing) {
    const match = pattern.exec(tag);
    if (!match) continue;
    highest = Math.max(highest, Number(match[1]));
  }
  if (highest >= 99) {
    throw new Error(`attempt index for ${day} is exhausted`);
  }
  return `t${day}-${String(highest + 1).padStart(2, "0")}`;
}

function remoteTags(repo) {
  const output = execFileSync(
    "git",
    ["ls-remote", "--tags", `https://github.com/${repo}.git`],
    { encoding: "utf8" }
  );
  const tags = new Set();
  for (const line of output.split("\n")) {
    const ref = line.split(/\s+/)[1] || "";
    const match = /^refs\/tags\/(t\d{8}-\d{2})(?:\^\{\})?$/.exec(ref);
    if (match) tags.add(match[1]);
  }
  return [...tags];
}

if (require.main === module) {
  try {
    const { values } = parseArgs({
      options: { repo: { type: "string" } },
    });
    if (!values.repo) throw new Error("pass --repo owner/name");
    process.stdout.write(`${nextAttemptTag(remoteTags(values.repo))}\n`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { nextAttemptTag, utcDay };
