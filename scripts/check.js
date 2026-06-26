// One-shot validation used by CI and `npm run check`:
//   1. node --check every root-level .js file
//   2. validate package.json parses
//   3. syntax-check inline <script> blocks in every HTML file
// No dependencies, cross-platform.
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { checkHtml } = require("./check-html.js");

const root = path.join(__dirname, "..");
let failed = 0;

// 1. JS syntax
const jsFiles = fs.readdirSync(root).filter((f) => f.endsWith(".js"));
for (const file of jsFiles) {
  try {
    execFileSync(process.execPath, ["--check", path.join(root, file)], { stdio: "pipe" });
  } catch (e) {
    failed++;
    console.error(`FAIL: ${file}\n${e.stderr ? e.stderr.toString() : e.message}`);
  }
}
if (!failed) console.log(`OK: ${jsFiles.length} JS file(s) parsed cleanly.`);

// 2. package.json
try {
  JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  console.log("OK: package.json is valid JSON.");
} catch (e) {
  failed++;
  console.error(`FAIL: package.json: ${e.message}`);
}

// 3. Inline HTML scripts
failed += checkHtml();

if (failed) {
  console.error(`\n${failed} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll checks passed.");
