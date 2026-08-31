const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const pkgPath = path.join(__dirname, "..", "package.json");
const originalContent = fs.readFileSync(pkgPath, "utf8");
const pkg = JSON.parse(originalContent);

const vsixFile = `smart-class-lookup-${pkg.version}-ovsx.vsix`;
if (!fs.existsSync(path.join(__dirname, "..", vsixFile))) {
  console.log(`VSIX file ${vsixFile} not found, packaging first...`);
  require("./package-ovsx.js");
}

console.log(`Publishing ${vsixFile} to Open VSX registry (ID: nazmul-hossain-adnan.smart-class-lookup)...`);
execSync(`npx ovsx publish ${vsixFile}`, { stdio: "inherit" });
