// Print the notes for one release from CHANGELOG.md, so the GitHub release
// body and the changelog can never drift apart.
//
//   node scripts/release-notes.js            -> the topmost version section
//   node scripts/release-notes.js 0.1.15     -> that specific version
//
// Exits non-zero (with nothing on stdout) when the section is not found, so a
// release workflow can fall back instead of publishing an empty body.
const fs = require("fs");
const path = require("path");

const changelogPath = path.join(__dirname, "..", "CHANGELOG.md");

// A version heading looks like "## 0.1.15". Anything else at that level (for
// example "## Earlier releases") ends the section.
const VERSION_HEADING = /^##\s+v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\s*$/;

function extract(markdown, wanted) {
  const lines = markdown.split(/\r?\n/);
  let start = -1;
  let version = null;
  for (let i = 0; i < lines.length; i++) {
    const m = VERSION_HEADING.exec(lines[i]);
    if (!m) continue;
    if (!wanted || m[1] === wanted.replace(/^v/, "")) {
      start = i + 1;
      version = m[1];
      break;
    }
  }
  if (start === -1) return null;

  let end = lines.length;
  for (let i = start; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) { end = i; break; }
  }
  return { version, body: lines.slice(start, end).join("\n").trim() };
}

function main() {
  let markdown;
  try {
    markdown = fs.readFileSync(changelogPath, "utf8");
  } catch (e) {
    process.stderr.write("No CHANGELOG.md: " + e.message + "\n");
    process.exit(1);
  }
  const found = extract(markdown, process.argv[2]);
  if (!found || !found.body) {
    process.stderr.write("No release notes found in CHANGELOG.md" +
      (process.argv[2] ? ` for ${process.argv[2]}` : "") + "\n");
    process.exit(1);
  }
  process.stdout.write(found.body + "\n");
}

module.exports = { extract };

if (require.main === module) main();
