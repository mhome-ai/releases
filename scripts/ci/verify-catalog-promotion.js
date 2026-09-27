const fs = require("node:fs");
function verifyPromotion(currentBytes, nextBytes) {
  const current = JSON.parse(currentBytes);
  const next = JSON.parse(nextBytes);
  const version = (value) => {
    if (!/^\d+\.\d+\.\d+$/.test(value || ""))
      throw new Error("Invalid stable release version");
    return value.split(".").map(Number);
  };
  const left = version(current.releaseVersion || current.productVersion),
    right = version(next.releaseVersion || next.productVersion);
  const difference = right.map((n, i) => n - left[i]).find((n) => n !== 0) || 0;
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
