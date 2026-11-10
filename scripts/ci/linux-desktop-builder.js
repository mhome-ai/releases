"use strict";

const { execFileSync, spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");

function run(args) {
  return execFileSync("docker", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();
}
async function main() {
  const [baycat, releases] = process.argv
    .slice(2)
    .map((value) => path.resolve(value));
  if (!baycat || !releases || !fs.existsSync(path.join(baycat, ".git")))
    throw new Error("Expected frozen Baycat and Releases worktrees");
  const work = path.dirname(baycat);
  if (
    path.dirname(work) !== "/home/runner/.mhome/work" ||
    path.dirname(releases) !== work
  )
    throw new Error("Desktop builder requires owned release worktrees");
  const hostname = fs.readFileSync("/etc/hostname", "utf8").trim();
  if (!/^meow-linux-(arm64|amd64)-runner$/.test(hostname))
    throw new Error("Unexpected Linux runner");
  const info = JSON.parse(run(["inspect", hostname]))[0];
  const mounts = [
    "/home/runner/.mhome",
    "/home/runner/.cargo",
    "/home/runner/.cache/compiler-cache",
    "/home/runner/.ssh",
  ]
    .map((destination) => {
      const mount = info.Mounts.find(
        (item) => item.Destination === destination
      );
      if (!mount || mount.Type !== "volume" || !mount.Name)
        throw new Error(`Missing owned volume ${destination}`);
      return [
        "--mount",
        `type=volume,src=${mount.Name},dst=${destination}${
          destination.endsWith("/.ssh") ? ",readonly" : ""
        }`,
      ];
    })
    .flat();
  if (!["arm64", "x64"].includes(process.arch))
    throw new Error("Unsupported desktop runner architecture");
  const platform = process.arch === "arm64" ? "linux/arm64" : "linux/amd64";
  const image = `meow-desktop-builder:${process.arch}`;
  execFileSync(
    "docker",
    [
      "build",
      "--platform",
      platform,
      "-t",
      image,
      "-f",
      path.join(releases, "runners/desktop-linux/Dockerfile"),
      path.join(releases, "runners"),
    ],
    { stdio: "inherit" }
  );
  // Cache downloaded bundler tools and npm payloads in the existing source
  // volume; compiler objects keep the separately bounded runner cache.
  fs.mkdirSync("/home/runner/.mhome/cache/desktop-tools", { recursive: true });
  const name = `meow-desktop-${path.basename(work)}`;
  if (!/^[a-zA-Z0-9_.-]+$/.test(name))
    throw new Error("Invalid owned container name");
  const args = [
    "run",
    "--rm",
    "--platform",
    platform,
    // WebKit creates unprivileged user namespaces. Docker's default seccomp
    // blocks those syscalls; retain WebKit's sandbox and remove all container
    // capabilities instead of disabling the browser sandbox for acceptance.
    "--cap-drop",
    "ALL",
    "--security-opt",
    "seccomp=unconfined",
    "--security-opt",
    "no-new-privileges=true",
    "--name",
    name,
    ...mounts,
    "--env",
    "TAURI_SIGNING_PRIVATE_KEY",
    "--env",
    "TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
    "--workdir",
    baycat,
    image,
    "bash",
    "scripts/release/linux/build-linux-desktop.sh",
  ];
  const child = spawn("docker", args, { stdio: "inherit" });
  let stopped = false;
  const stop = () => {
    if (!stopped) {
      stopped = true;
      run(["rm", "--force", name]);
    }
  };
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, () => {
      try {
        stop();
      } finally {
        process.exit(1);
      }
    });
  child.on("error", (error) => {
    console.error(error);
    process.exitCode = 1;
  });
  child.on("exit", (code, signal) => {
    process.exitCode = signal ? 1 : code ?? 1;
  });
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
