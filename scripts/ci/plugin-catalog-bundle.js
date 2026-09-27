const fs = require("node:fs");
function pack(catalog, signature, output) {
  fs.writeFileSync(
    output,
    `${JSON.stringify({
      schemaVersion: 1,
      kind: "meow.plugin.catalog-bundle",
      catalog: fs.readFileSync(catalog, "utf8"),
      signature: fs.readFileSync(signature, "utf8"),
    })}\n`
  );
}
function unpack(input, catalog, signature) {
  const value = JSON.parse(fs.readFileSync(input));
  if (
    value.schemaVersion !== 1 ||
    value.kind !== "meow.plugin.catalog-bundle" ||
    typeof value.catalog !== "string" ||
    typeof value.signature !== "string"
  )
    throw new Error("Invalid Plugin Catalog bundle");
  fs.writeFileSync(catalog, value.catalog);
  fs.writeFileSync(signature, value.signature);
}
module.exports = { pack, unpack };
if (require.main === module) {
  const [action, ...args] = process.argv.slice(2);
  if (action === "pack") pack(...args);
  else if (action === "unpack") unpack(...args);
  else throw new Error("Expected pack or unpack");
}
