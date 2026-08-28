/* QGN Studio: presets and tuning constants.
   Pure data, no DOM, no state. Loaded first. */

/* ───────────────────────── Backgrounds ───────────────────────── */
const GRADIENTS = [
  { id: "indigo", angle: 135, stops: [[0, "#4f46e5"], [1, "#9333ea"]] },
  { id: "blush",  angle: 135, stops: [[0, "#ff6a88"], [1, "#ff99ac"]] },
  { id: "ocean",  angle: 135, stops: [[0, "#2193b0"], [1, "#6dd5ed"]] },
  { id: "lime",   angle: 135, stops: [[0, "#0ba360"], [1, "#3cba92"]] },
  { id: "peach",  angle: 135, stops: [[0, "#ffd194"], [1, "#fc8d6f"]] },
  { id: "grape",  angle: 135, stops: [[0, "#654ea3"], [1, "#eaafc8"]] },
  { id: "sky",    angle: 135, stops: [[0, "#56ccf2"], [1, "#2f80ed"]] },
  { id: "slate",  angle: 135, stops: [[0, "#e0eafc"], [1, "#cfdef3"]] },
  { id: "coral",  angle: 135, stops: [[0, "#ff9966"], [1, "#ff5e62"]] },
  { id: "night",  angle: 135, stops: [[0, "#0f2027"], [0.5, "#203a43"], [1, "#2c5364"]] },
];

const WALLPAPERS = [
  { id: "aurora",  base: "#0b1020", blend: "lighter", blobs: [
    { x: 0.18, y: 0.22, r: 0.75, c: "#3b82f6" },
    { x: 0.84, y: 0.20, r: 0.65, c: "#8b5cf6" },
    { x: 0.62, y: 0.88, r: 0.80, c: "#06b6d4" } ] },
  { id: "sequoia", base: "#1a0f2e", blend: "lighter", blobs: [
    { x: 0.20, y: 0.25, r: 0.70, c: "#ec4899" },
    { x: 0.85, y: 0.30, r: 0.70, c: "#8b5cf6" },
    { x: 0.55, y: 0.90, r: 0.75, c: "#f97316" } ] },
  { id: "mint",    base: "#04211a", blend: "lighter", blobs: [
    { x: 0.22, y: 0.20, r: 0.72, c: "#10b981" },
    { x: 0.82, y: 0.28, r: 0.66, c: "#22d3ee" },
    { x: 0.55, y: 0.92, r: 0.72, c: "#34d399" } ] },
  { id: "bigsur",  base: "#08243f", blend: "lighter", blobs: [
    { x: 0.15, y: 0.25, r: 0.75, c: "#2563eb" },
    { x: 0.80, y: 0.18, r: 0.65, c: "#0ea5e9" },
    { x: 0.70, y: 0.90, r: 0.80, c: "#6366f1" } ] },
  { id: "ember",   base: "#1b0a12", blend: "lighter", blobs: [
    { x: 0.20, y: 0.28, r: 0.72, c: "#f43f5e" },
    { x: 0.85, y: 0.25, r: 0.62, c: "#fb923c" },
    { x: 0.55, y: 0.92, r: 0.70, c: "#a855f7" } ] },
  { id: "bloom",   base: "#fde4ec", blend: "normal", blobs: [
    { x: 0.18, y: 0.22, r: 0.70, c: "#c7d2fe" },
    { x: 0.84, y: 0.26, r: 0.66, c: "#fbcfe8" },
    { x: 0.55, y: 0.88, r: 0.74, c: "#bae6fd" } ] },
];

const ASPECTS = { auto: null, "16:9": 16 / 9, "4:3": 4 / 3, "1:1": 1, "9:16": 9 / 16, "3:2": 3 / 2 };

const MAX_SAVED_COLORS = 24;
const MAX_SAVED_GRADIENTS = 24;

/* ───────────────────────── Annotation sizing ─────────────────────────
   Every annotation dimension is a fraction of the source's larger side, so a
   stroke drawn on a 4K capture exports at the same relative weight as one
   drawn on a 720p capture, at any window size. */
const MAX_STROKES = 500;
const HISTORY_LIMIT = 100;
const TEXT_FRAC = { S: 0.014, M: 0.02, L: 0.03 };
const PIXEL_FRAC = { S: 0.005, M: 0.01, L: 0.02 };
const STROKE_FRAC = 0.004;   // freehand / shape / arrow line width
const CALLOUT_FRAC = 0.014;  // numbered callout radius
const CURSOR_STAMP_FRAC = 0.0014; // per unit of CURSOR_POINTS

// Perimeter of a standard arrow cursor in unit space (tip at 0,0).
const CURSOR_POINTS = [
  [0, 0], [0, 17], [3.7, 13.3], [6.0, 18.4],
  [8.1, 17.5], [5.7, 12.5], [10.5, 12.5],
];

const ANNOTATION_COLORS = ["#ff3b30", "#ff9500", "#ffcc00", "#34c759", "#007aff", "#ffffff"];

/* ───────────────────────── Video export ───────────────────────── */
const FORMAT_HINTS = {
  mp4: "MP4: best for sharing. Keeps audio. Rendered in real time.",
  webm: "WebM: open format, smaller files. Keeps audio. Rendered in real time.",
  gif: "GIF: looping, no audio. Capped to 800px / 15fps; long clips are sampled sparser.",
  webp: "Animated WebP: looping, no audio. Smaller and sharper than GIF.",
};

// GIF/WebP encode from still frames; cap size + frame rate so memory and file
// size stay reasonable.
const GIF_MAX_LONG = 800;
const WEBP_MAX_LONG = 1000;
const ANIM_FPS = 15;
const ANIM_MAX_FRAMES = 450; // ~30s at 15fps; fps drops if a trim exceeds this
const ENCODED_MAX_LONG = 1920; // mp4/webm long-side cap
// Real-time export watchdog: how often to check that the playhead is still
// moving, and how many consecutive still checks mean playback has stalled.
const EXPORT_WATCH_MS = 250;
const EXPORT_STALL_TICKS = 16; // 4s of no progress
// Raw RGBA the main process assembles the animation from. A long clip is
// scaled down to fit rather than refused. Kept in sync with
// RAW_BUDGET_BYTES in lib/animation.js, which enforces it.
const ANIM_RAW_BUDGET = 384 * 1024 * 1024;
const ANIM_MIN_LONG = 240; // never shrink an animation below this long side

/* ───────────────────────── Motion tuning ───────────────────────── */
// Auto-zoom heuristics (see generateAutoZoom).
const AUTOZOOM = {
  CLUSTER_GAP: 1.2, // s, clicks closer than this join one zoom
  LEAD: 0.35,       // s, start zoom before the first click
  DWELL: 1.4,       // s, hold zoom after the last click
  SCALE: 1.9,       // default zoom factor
  MIN_SCALE: 1.4,
  MERGE_GAP: 0.6,   // s, merge segments nearly touching
  MIN_LEN: 0.9,     // s, drop segments shorter than this
};
const CURSOR_SMOOTH_TAU = 0.06; // s, cursor position smoothing time constant
const CURSOR_GRID_DT = 1 / 120; // s, resample grid for the smoothed table
const RIPPLE_DUR = 0.5;         // s, click ripple lifetime
const MIN_SEG = 0.4;            // s, minimum zoom-segment length
