// Cross-check every element a renderer reaches for against the markup it runs
// against.
//
// Each window here is an HTML file plus its inline scripts and whatever local
// scripts it pulls in with <script src>. A getElementById for an id the markup
// does not have throws on the very first line that touches it, which takes the
// whole window down: the update card, the settings popover, all of Studio. That
// is a class of bug a syntax check cannot see, and it is entirely static, so it
// belongs in the same one-shot validation pass.
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");

// Ids the app creates at runtime rather than declaring in markup would show up
// as false positives. There are none today; list them here if that changes.
const RUNTIME_IDS = new Set();

function readIfExists(p) {
  try { return fs.readFileSync(p, "utf8"); } catch { return null; }
}

// id="foo" / id='foo' declared anywhere in the markup.
function declaredIds(html) {
  const ids = new Set();
  const re = /\bid\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(html))) ids.add(m[1]);
  return ids;
}

// Strip comments and strings-in-comments cheaply so a commented-out lookup does
// not get reported. Good enough for this codebase's plain scripts.
function stripComments(code) {
  return code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

// getElementById("foo") and querySelector("#foo") with a literal argument.
// Anything computed is skipped: it cannot be checked statically.
function referencedIds(code) {
  const out = [];
  const clean = stripComments(code);
  const byId = /getElementById\(\s*["']([^"']+)["']\s*\)/g;
  let m;
  while ((m = byId.exec(clean))) out.push(m[1]);
  const bySel = /querySelector(?:All)?\(\s*["']#([A-Za-z][\w-]*)["']\s*\)/g;
  while ((m = bySel.exec(clean))) out.push(m[1]);
  return out;
}

function inlineScripts(html) {
  const out = [];
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) out.push(m[1]);
  return out;
}

// Local <script src="..."> only; anything remote is not ours to check.
function linkedScripts(html) {
  const out = [];
  const re = /<script[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi;
  let m;
  while ((m = re.exec(html))) {
    const src = m[1];
    if (/^[a-z]+:/i.test(src) || src.startsWith("//")) continue;
    out.push(src.replace(/^\.\//, ""));
  }
  return out;
}

function checkDom() {
  const htmlFiles = fs.readdirSync(root).filter((f) => f.toLowerCase().endsWith(".html"));
  let failed = 0;
  let checkedRefs = 0;

  for (const file of htmlFiles) {
    const html = readIfExists(path.join(root, file));
    if (html === null) continue;
    const ids = declaredIds(html);

    const sources = inlineScripts(html).map((code, i) => ({ label: `${file} (inline script ${i + 1})`, code }));
    for (const src of linkedScripts(html)) {
      const code = readIfExists(path.join(root, src));
      if (code === null) {
        failed++;
        console.error(`FAIL: ${file} loads ${src}, which does not exist.`);
        continue;
      }
      sources.push({ label: `${src} (loaded by ${file})`, code });
    }

    for (const { label, code } of sources) {
      for (const id of referencedIds(code)) {
        checkedRefs++;
        if (!ids.has(id) && !RUNTIME_IDS.has(id)) {
          failed++;
          console.error(`FAIL: ${label} looks up #${id}, which ${file} does not declare.`);
        }
      }
    }
  }

  if (!failed) {
    console.log(`OK: ${checkedRefs} element lookup(s) resolve against their markup.`);
  }
  return failed;
}

module.exports = { checkDom };

if (require.main === module) {
  process.exit(checkDom() ? 1 : 0);
}
