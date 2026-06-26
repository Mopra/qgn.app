// Syntax-checks the inline <script> blocks inside every root-level HTML file.
// A typo in a window's renderer script would otherwise only surface at runtime.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

function checkHtml() {
  const root = path.join(__dirname, "..");
  const htmlFiles = fs
    .readdirSync(root)
    .filter((f) => f.toLowerCase().endsWith(".html"));

  let failed = 0;
  let checked = 0;

  for (const file of htmlFiles) {
    const html = fs.readFileSync(path.join(root, file), "utf8");
    // Match <script> blocks with no src attribute (inline code only).
    const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
    let m;
    let i = 0;
    while ((m = re.exec(html))) {
      i++;
      const code = m[1];
      if (!code.trim()) continue;
      checked++;
      try {
        // Compile only — never executes, so browser globals are irrelevant.
        new vm.Script(code, { filename: `${file}#script${i}` });
      } catch (e) {
        failed++;
        console.error(`FAIL: ${file} (script ${i}): ${e.message}`);
      }
    }
  }

  if (!failed) {
    console.log(`OK: ${checked} inline script(s) across ${htmlFiles.length} HTML files parsed cleanly.`);
  }
  return failed;
}

module.exports = { checkHtml };

// Allow running standalone: `node scripts/check-html.js`
if (require.main === module) {
  process.exit(checkHtml() ? 1 : 0);
}
