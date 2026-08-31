const { execSync } = require("child_process");
const pkg = require("../package.json");

const outputFile = `smart-class-lookup-${pkg.version}-ovsx.vsix`;
console.log(`Building OpenVSX package: ${outputFile}...`);
execSync(`npx vsce package -o ${outputFile}`, { stdio: "inherit" });
console.log(`Created ${outputFile}`);
