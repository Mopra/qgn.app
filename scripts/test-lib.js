// Pure-Node unit tests for lib/. No Electron, no display, no native modules
// beyond what is already installed, so `npm run check` (and therefore CI) can
// run them on every push.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { sanitizeStudioColors, sanitizeStudioGradients, MAX_STUDIO_COLORS, MAX_STUDIO_GRADIENTS } = require("../lib/palette.js");
const { fileExt, videoMimeForPath, isPlayableVideoPath, canOpenInStudio } = require("../lib/media.js");
const { RAW_BUDGET_BYTES, MAX_FRAMES } = require("../lib/animation.js");

const cases = [];
function test(name, fn) { cases.push({ name, fn }); }

/* ───────────────────────── palette ───────────────────────── */
test("colors: a non-array means 'nothing saved yet'", () => {
  assert.strictEqual(sanitizeStudioColors(undefined), null);
  assert.strictEqual(sanitizeStudioColors(null), null);
  assert.strictEqual(sanitizeStudioColors("#ffffff"), null);
  assert.strictEqual(sanitizeStudioColors({ 0: "#ffffff" }), null);
});

test("colors: an empty array is a deliberately empty palette, not a default", () => {
  assert.deepStrictEqual(sanitizeStudioColors([]), []);
});

test("colors: junk is dropped, valid hex is uppercased", () => {
  assert.deepStrictEqual(
    sanitizeStudioColors(["#ff0000", "red", "#GGG", 42, null, "#00ff00", "#abc", undefined, {}]),
    ["#FF0000", "#00FF00"]
  );
});

test("colors: duplicates collapse case-insensitively", () => {
  assert.deepStrictEqual(sanitizeStudioColors(["#AaBbCc", "#aabbcc", "#AABBCC"]), ["#AABBCC"]);
});

test("colors: the palette is capped", () => {
  const many = Array.from({ length: 100 }, (_, i) => "#" + i.toString(16).padStart(6, "0"));
  assert.strictEqual(sanitizeStudioColors(many).length, MAX_STUDIO_COLORS);
});

test("gradients: a non-array means 'nothing saved yet'", () => {
  assert.strictEqual(sanitizeStudioGradients(undefined), null);
  assert.strictEqual(sanitizeStudioGradients("nope"), null);
});

test("gradients: entries need two valid colors", () => {
  assert.deepStrictEqual(sanitizeStudioGradients([
    { angle: 90, c0: "#ff0000", c1: "#00ff00" },
    { angle: 90, c0: "#ff0000" },
    { angle: 90, c0: "nope", c1: "#00ff00" },
    null,
    "gradient",
  ]), [{ angle: 90, c0: "#FF0000", c1: "#00FF00" }]);
});

test("gradients: angles normalize into 0-359 and a missing angle defaults to 135", () => {
  const out = sanitizeStudioGradients([
    { angle: 450, c0: "#111111", c1: "#222222" },
    { angle: -90, c0: "#333333", c1: "#444444" },
    { angle: "nope", c0: "#555555", c1: "#666666" },
    { c0: "#777777", c1: "#888888" },
  ]);
  assert.deepStrictEqual(out.map((g) => g.angle), [90, 270, 135, 135]);
});

test("gradients: the same gradient written two ways dedupes", () => {
  const out = sanitizeStudioGradients([
    { angle: 45, c0: "#aabbcc", c1: "#ddeeff" },
    { angle: 405, c0: "#AABBCC", c1: "#DDEEFF" },
  ]);
  assert.strictEqual(out.length, 1);
});

test("gradients: the palette is capped", () => {
  const many = Array.from({ length: 100 }, (_, i) => ({ angle: i, c0: "#000000", c1: "#ffffff" }));
  assert.strictEqual(sanitizeStudioGradients(many).length, MAX_STUDIO_GRADIENTS);
});

/* ───────────────────────── media ───────────────────────── */
test("fileExt is case-insensitive and safe on empty input", () => {
  assert.strictEqual(fileExt("C:\\clips\\a.MP4"), "mp4");
  assert.strictEqual(fileExt("/tmp/a.WebM"), "webm");
  assert.strictEqual(fileExt("noextension"), "");
  assert.strictEqual(fileExt(null), "");
  assert.strictEqual(fileExt(undefined), "");
});

test("video MIME follows the container", () => {
  assert.strictEqual(videoMimeForPath("a.webm"), "video/webm");
  assert.strictEqual(videoMimeForPath("a.mov"), "video/quicktime");
  assert.strictEqual(videoMimeForPath("a.mkv"), "video/x-matroska");
  assert.strictEqual(videoMimeForPath("a.mp4"), "video/mp4");
  assert.strictEqual(videoMimeForPath("a.m4v"), "video/mp4");
});

test("animations are not playable video containers", () => {
  assert.strictEqual(isPlayableVideoPath("a.mp4"), true);
  assert.strictEqual(isPlayableVideoPath("a.gif"), false);
  assert.strictEqual(isPlayableVideoPath("a.webp"), false);
  assert.strictEqual(isPlayableVideoPath("a.png"), false);
  assert.strictEqual(isPlayableVideoPath(null), false);
});

test("Studio opens stills always, and clips only when decodable", () => {
  assert.strictEqual(canOpenInStudio({ isVideo: false, filePath: "a.png" }), true);
  assert.strictEqual(canOpenInStudio({ isVideo: false, filePath: null }), true, "an unsaved capture is still editable");
  assert.strictEqual(canOpenInStudio({ isVideo: true, filePath: "a.mp4" }), true);
  assert.strictEqual(canOpenInStudio({ isVideo: true, filePath: "a.gif" }), false);
  assert.strictEqual(canOpenInStudio({ isVideo: true, filePath: "a.webp" }), false);
  assert.strictEqual(canOpenInStudio({ isVideo: true, filePath: null }), false);
  assert.strictEqual(canOpenInStudio(null), false);
});

/* ─────────────── renderer / main agreement ───────────────
   Studio plans its animation exports to fit a budget the main process then
   enforces. The two constants live in different worlds (a classic script and a
   CommonJS module) and cannot import each other, so this is what keeps them
   from drifting into "renders fine, then fails on save". */
test("Studio's export budget matches what the assembler enforces", () => {
  const presets = fs.readFileSync(path.join(__dirname, "..", "studio", "presets.js"), "utf8");

  const budget = /const\s+ANIM_RAW_BUDGET\s*=\s*([^;]+);/.exec(presets);
  assert.ok(budget, "ANIM_RAW_BUDGET is gone from studio/presets.js");
  // eslint-disable-next-line no-new-func -- a numeric literal expression only.
  assert.strictEqual(Function(`"use strict";return (${budget[1]})`)(), RAW_BUDGET_BYTES,
    "ANIM_RAW_BUDGET and RAW_BUDGET_BYTES disagree");

  const cap = /const\s+ANIM_MAX_FRAMES\s*=\s*(\d+)/.exec(presets);
  assert.ok(cap, "ANIM_MAX_FRAMES is gone from studio/presets.js");
  assert.ok(Number(cap[1]) <= MAX_FRAMES,
    `Studio can plan ${cap[1]} frames but the assembler rejects more than ${MAX_FRAMES}`);
});

function runLibTests() {
  let failed = 0;
  for (const { name, fn } of cases) {
    try {
      fn();
    } catch (e) {
      failed++;
      console.error(`FAIL: ${name}\n      ${e.message}`);
    }
  }
  if (!failed) console.log(`OK: ${cases.length} lib unit test(s) passed.`);
  return failed;
}

module.exports = { runLibTests };

if (require.main === module) {
  process.exit(runLibTests() ? 1 : 0);
}
