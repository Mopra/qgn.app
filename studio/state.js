/* QGN Studio: the single scene state, plus the media-source abstraction that
   lets one renderer drive both stills and clips.

   The rest of the app never touches `source.el` directly: it asks for srcW() /
   srcH() / drawSource(), which hide the difference between an <img> and a
   <video>, and apply the crop rect. That is what makes the scene, annotation
   and export code media-agnostic. */

const state = {
  // ── Scene (shared by stills and clips) ──
  bgMode: "gradient",
  gradientId: "indigo",
  gradientCustom: { angle: 135, c0: "#6366f1", c1: "#9333ea" },
  wallpaperId: "aurora",
  solidColor: "#6366f1",
  customImage: null,
  frame: "window",
  frameTheme: "light",
  url: "app.example.com",
  // Fractions of the source's larger dimension, for resolution-independent
  // output. Slider values (0-100) map onto these.
  padPct: 0.08,
  radiusPct: 0.018,
  shadowPct: 0.05,
  aspect: "auto",

  // ── Crop: a rect in original source pixels, or null for the whole source ──
  crop: null,

  // ── Annotation ──
  tool: "none", // none | draw | arrow | rect | ellipse | diamond | line | text | redact | callout | cursor | crop
  shapeType: "rect",
  color: "#ff3b30",
  textSize: "M",
  pixelSize: "M",
  redactStyle: "solid", // solid | pixelate
  strokes: [],
  calloutCounter: 1,
  // Id of the stroke the pointer tool has selected, or null. Ids are stable
  // across edits and undo; array positions are not.
  selectedStrokeId: null,

  // ── Video only ──
  format: "mp4",
  muted: false,
  loop: true,
  trimIn: 0,
  trimOut: 0,
  motion: null,        // raw sidecar { events, region, duration, ... } or null
  zoomSegments: [],    // [{ id, startT, endT, cx, cy, scale, easeIn, easeOut, source }]
  selectedSegId: null,
  autoZoom: true,      // regenerate auto zoom-ins from clicks on load
  cursor: {
    // Off by default: the recorded video already contains the real OS cursor
    // (Windows capture can't reliably hide it), so the synthetic cursor is an
    // opt-in that would otherwise double up. The click ripple, however, is a
    // nice highlight around the real cursor.
    enabled: false,
    style: "arrow", // arrow | dot | ring
    size: 1.0,
    color: "#ffffff",
    ripple: true,
  },
};

/* ───────────────────────── Editor mode ─────────────────────────
   "markup" opens lean (no sidebar) and saves back over the source, the way the
   old annotation editor did. "compose" opens the full workspace and saves a
   brand-new image. Same window, same code; only the defaults and the save
   channel differ. */
let editorMode = "compose";

/* ───────────────────────── Media source ───────────────────────── */
const source = {
  kind: "none", // none | image | video
  el: null,     // HTMLImageElement | HTMLVideoElement
  naturalW: 0,
  naturalH: 0,
  loaded: false,
};

function hasSource() { return source.kind !== "none" && source.naturalW > 0 && source.naturalH > 0; }

// True when the element actually has pixels to draw. Video needs a decoded
// frame, which lands later than the metadata that gives us the dimensions.
function sourceReady() {
  if (!source.loaded || !source.el) return false;
  if (source.kind === "video") return source.el.readyState >= 2;
  return true;
}

// The visible region of the source, in original source pixels.
function cropX() { return state.crop ? state.crop.x : 0; }
function cropY() { return state.crop ? state.crop.y : 0; }
function srcW() { return state.crop ? state.crop.w : source.naturalW; }
function srcH() { return state.crop ? state.crop.h : source.naturalH; }

// The reference dimension every relative size is measured against.
function baseDim() { return Math.max(srcW(), srcH()) || 1; }

// Draw the visible source region with its top-left at (x, y), at 1:1 source
// pixels. The caller's transform supplies the scale.
function drawSource(ctx, x, y) {
  const w = srcW(), h = srcH();
  if (!sourceReady()) {
    ctx.fillStyle = "#000";
    ctx.fillRect(x, y, w, h);
    return;
  }
  try {
    ctx.drawImage(source.el, cropX(), cropY(), w, h, x, y, w, h);
  } catch (e) {
    ctx.fillStyle = "#000";
    ctx.fillRect(x, y, w, h);
  }
}

// Playhead time. Stills are a single frame at t=0, which makes every
// time-driven effect (camera, ripples) a no-op for them.
function currentTime() {
  if (source.kind === "video" && source.loaded) return source.el.currentTime;
  return 0;
}

/* ───────────────────────── Undo / redo ─────────────────────────
   Snapshots rather than inverse operations: strokes are immutable once
   committed, so a snapshot is a shallow array copy plus a small crop rect.
   That keeps crop, draw and clear on one stack with no per-op bookkeeping. */
let undoStack = [];
let redoStack = [];

function snapshot() {
  return { strokes: state.strokes.slice(), crop: state.crop ? { ...state.crop } : null };
}
function restore(snap) {
  state.strokes = snap.strokes.slice();
  state.crop = snap.crop ? { ...snap.crop } : null;
  // Callout numbering follows whatever callouts survive the restore.
  state.calloutCounter = state.strokes.reduce((n, s) => (s.type === "callout" ? n + 1 : n), 0) + 1;
  // An undo can take the selected stroke away with it.
  if (state.selectedStrokeId != null &&
      !state.strokes.some((s) => s.id === state.selectedStrokeId)) {
    state.selectedStrokeId = null;
  }
}

// Call immediately BEFORE mutating strokes/crop.
function pushHistory() {
  undoStack.push(snapshot());
  if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
  redoStack = [];
}

function resetHistory() {
  undoStack = [];
  redoStack = [];
}

/* ───────────────────────── Dirty tracking ─────────────────────────
   Any edit flags the session dirty so closing can warn before discarding. The
   seed image handed over from a capture is not a "change". */
let dirty = false;
function markDirty() { dirty = true; }
