const fs = require("node:fs");
function verifyPromotion(currentBytes, nextBytes) {
  const current = JSON.parse(currentBytes);
  const next = JSON.parse(nextBytes);
  const generation = (value) => {
    if (/^\d{14}$/.test(value || "")) return { kind: "stamp", value };
    if (/^\d+\.\d+\.\d+$/.test(value || "")) {
      return { kind: "semver", parts: value.split(".").map(Number) };
    }
    throw new Error("Invalid stable release version");
  };
  const compare = (older, newer) => {
    if (older.kind === "stamp" && newer.kind === "stamp") {
      if (older.value === newer.value) return 0;
      return older.value < newer.value ? 1 : -1;
    }
    if (older.kind === "semver" && newer.kind === "stamp") return 1;
    if (older.kind === "stamp" && newer.kind === "semver") return -1;
    return (
      newer.parts.map((part, index) => part - older.parts[index]).find((part) => part !== 0) ||
      0
    );
  };
  const difference = compare(
    generation(current.releaseVersion || current.productVersion),
    generation(next.releaseVersion || next.productVersion)
  );
  if (
    current.kind !== next.kind ||
    current.channel !== next.channel ||
    current.platform !== next.platform
  )
    throw new Error("Catalog source changed");
  if (difference < 0) throw new Error("Cannot move stable backwards");
  if (
    difference === 0 &&
    !Buffer.from(currentBytes).equals(Buffer.from(nextBytes))
  )
    throw new Error("Catalog bytes changed at the same version");
}
module.exports = { verifyPromotion };
if (require.main === module) {
  try {
    verifyPromotion(
      fs.readFileSync(process.argv[2]),
      fs.readFileSync(process.argv[3])
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
