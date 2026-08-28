// One-shot validation used by CI and `npm run check`:
//   1. node --check every first-party .js file
//   2. validate package.json parses
//   3. syntax-check inline <script> blocks in every HTML file
//   3b. cross-check every getElementById against the markup it runs against
//   4. run the pure-Node unit tests in scripts/test-lib.js
//   5. boot main.js against a stubbed Electron (scripts/test-main.js)
// No dependencies, cross-platform.
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { checkHtml } = require("./check-html.js");
const { checkDom } = require("./check-dom.js");
const { runLibTests } = require("./test-lib.js");

const root = path.join(__dirname, "..");
let failed = 0;

// 1. JS syntax (root plus first-party subdirectories such as studio/)
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", ".github", "assets", "icons"]);
function collectJs(dir, rel) {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = path.join(dir, name);
    const relPath = rel ? rel + "/" + name : name;
    if (fs.statSync(full).isDirectory()) out.push.apply(out, collectJs(full, relPath));
    else if (name.endsWith(".js")) out.push(relPath);
  }
  return out;
}
const jsFiles = collectJs(root, "");
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

// 3b. Element lookups resolve
failed += checkDom();

// 4. lib/ unit tests
failed += runLibTests();

// 5. main-process boot tests. Run in a child process: they load main.js for
// real, which is not something to do inside the checker's own process.
try {
  execFileSync(process.execPath, [path.join(__dirname, "test-main.js")], { stdio: "inherit" });
} catch (e) {
  failed++;
}

if (failed) {
  console.error(`\n${failed} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll checks passed.");
