const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const pkgPath = path.join(__dirname, "..", "package.json");
const originalContent = fs.readFileSync(pkgPath, "utf8");
const pkg = JSON.parse(originalContent);

const outputFile = `smart-class-lookup-${pkg.version}-ovsx.vsix`;
console.log(`Building OpenVSX package for 'nazmul-hossain-adnan.smart-class-lookup': ${outputFile}...`);

try {
  pkg.publisher = "nazmul-hossain-adnan";
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf8");
  execSync(`npx vsce package -o ${outputFile}`, { stdio: "inherit" });
  console.log(`Successfully created ${outputFile} (ID: nazmul-hossain-adnan.smart-class-lookup)`);
} finally {
  fs.writeFileSync(pkgPath, originalContent, "utf8");
}
