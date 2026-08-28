/* QGN Studio: the annotation layer.

   Strokes live in ORIGINAL source pixel coordinates, never in display pixels.
   That is the change that lets annotation share a window with composition: the
   canvas can be any size, the crop can move, the aspect ratio can change and
   the export can be any scale, and the marks stay exactly where they were put.

   Every size (line width, font, callout radius, pixel block) is resolved to
   source pixels once, at commit time, and stored on the stroke. A later crop
   therefore reframes the marks instead of resizing them. */

let currentStroke = null;   // in-progress stroke, not yet committed
let isDrawing = false;
let cropSel = null;         // pending crop rect while the crop tool is armed, never saved
let cropSelBase = null;     // visible region cropSel was seeded from, to spot a stale rect
let cropDrag = null;        // { mode, start, orig } while a side/corner/marquee is being dragged

const SHAPE_TOOLS = new Set(["rect", "ellipse", "diamond", "line"]);

/* ───────────────────────── Coordinate mapping ─────────────────────────
   Three spaces are in play:
     source  original media pixels, what strokes are stored in
     scene   the composed image (background + padding + frame)
     client  CSS pixels on screen
   The camera zoom sits between source and scene, so both directions have to
   go through it or annotations would drift on a zoomed clip. */

function sourceToScene(px, py, L) {
  const m = mediaOrigin(L);
  const iw = srcW(), ih = srcH();
  const cam = cameraAt(currentTime());
  return cameraMapPoint((px - cropX()) / iw, (py - cropY()) / ih, m.x, m.y, iw, ih, cam);
}

// Scene units per CSS pixel, or 0 when there is nothing on screen yet.
function previewFit(L) {
  const rect = previewCanvas.getBoundingClientRect();
  if (!rect.width || !L.sceneW) return 0;
  return rect.width / L.sceneW;
}

function clientToSource(clientX, clientY) {
  if (!hasSource()) return null;
  const L = layout();
  const fit = previewFit(L);
  if (!fit) return null;
  const rect = previewCanvas.getBoundingClientRect();
  const sceneX = (clientX - rect.left) / fit;
  const sceneY = (clientY - rect.top) / fit;
  const m = mediaOrigin(L);
  const iw = srcW(), ih = srcH();
  const cam = cameraAt(currentTime());
  const p = sceneToSourcePoint(sceneX, sceneY, m.x, m.y, iw, ih, cam);
  return { x: p.x + cropX(), y: p.y + cropY() };
}

function sourceToClient(px, py) {
  const L = layout();
  const fit = previewFit(L);
  if (!fit) return null;
  const rect = previewCanvas.getBoundingClientRect();
  const s = sourceToScene(px, py, L);
  return { x: rect.left + s.x * fit, y: rect.top + s.y * fit };
}

/* ───────────────────────── Undo / redo ───────────────────────── */
// Returns true when the stroke was actually added.
function commitStroke(s) {
  if (state.strokes.length >= MAX_STROKES) {
    showStudioToast("Annotation limit reached for this image.", true);
    return false;
  }
  pushHistory();
  // A stable id, so the selection survives edits, undo and reordering. Array
  // position does not.
  state.strokes.push({ ...s, id: nextStrokeId() });
  markDirty();
  syncAnnotationUI();
  requestPaint();
  return true;
}

function undo() {
  if (!undoStack.length) return;
  redoStack.push(snapshot());
  restore(undoStack.pop());
  markDirty();
  syncAnnotationUI();
  requestPaint();
}

function redo() {
  if (!redoStack.length) return;
  undoStack.push(snapshot());
  restore(redoStack.pop());
  markDirty();
  syncAnnotationUI();
  requestPaint();
}

/* ───────────────────────── Rendering ─────────────────────────
   Called from inside paintScene, already under the media transform. (mx, my)
   is where the visible top-left of the source lands, so shifting by the crop
   origin puts original source coordinates in the right place. */
function drawAnnotations(ctx, mx, my) {
  if (!state.strokes.length && !currentStroke) return;
  ctx.save();
  ctx.translate(mx - cropX(), my - cropY());
  for (const s of state.strokes) drawStroke(ctx, s);
  if (currentStroke) drawStroke(ctx, currentStroke);
  ctx.restore();
}

function drawStroke(ctx, s) {
  if (s.type === "text") {
    ctx.save();
    ctx.font = `600 ${s.fontPx}px -apple-system, "Segoe UI", system-ui, sans-serif`;
    ctx.fillStyle = s.color;
    ctx.textBaseline = "middle";
    ctx.fillText(s.text, s.pos.x, s.pos.y);
    ctx.restore();
    return;
  }

  if (s.type === "redact") {
    const x = Math.min(s.from.x, s.to.x);
    const y = Math.min(s.from.y, s.to.y);
    const w = Math.abs(s.to.x - s.from.x);
    const h = Math.abs(s.to.y - s.from.y);
    if (w < 1 || h < 1) return;

    // Solid block: opaque and unrecoverable (the safe default).
    if (s.style === "solid") {
      ctx.fillStyle = "#000";
      ctx.fillRect(x, y, w, h);
      return;
    }

    // Pixelate by sampling at reduced resolution and scaling back up with
    // smoothing off. The sample comes from what is already painted underneath,
    // NOT from the pristine source: sampling the source would let a pixelate
    // block drawn over a solid redaction re-expose the very pixels the block
    // was placed there to hide. Strokes paint in order, so by the time this
    // runs the canvas holds the media plus every earlier mark.
    if (!sourceReady()) { ctx.fillStyle = "#000"; ctx.fillRect(x, y, w, h); return; }
    const block = Math.max(1, s.block);
    // The grid is resolved in source pixels, so the block size is identical
    // whatever the canvas scale is.
    const cols = Math.max(1, Math.ceil(w / block));
    const rows = Math.max(1, Math.ceil(h / block));

    // Map the rect into device pixels on the destination canvas. The scene
    // transform is translate + scale only (nothing here ever rotates), so the
    // mapping is a straight one.
    const t = ctx.getTransform();
    const dx = t.a * x + t.c * y + t.e;
    const dy = t.b * x + t.d * y + t.f;
    const dw = t.a * w;
    const dh = t.d * h;
    if (!(dw >= 1 && dh >= 1)) { ctx.fillStyle = "#000"; ctx.fillRect(x, y, w, h); return; }

    const tmp = document.createElement("canvas");
    tmp.width = cols;
    tmp.height = rows;
    try {
      tmp.getContext("2d").drawImage(ctx.canvas, dx, dy, dw, dh, 0, 0, cols, rows);
    } catch (e) {
      ctx.fillStyle = "#000";
      ctx.fillRect(x, y, w, h);
      return;
    }
    const prevSmoothing = ctx.imageSmoothingEnabled;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(tmp, 0, 0, cols, rows, x, y, w, h);
    ctx.imageSmoothingEnabled = prevSmoothing;
    return;
  }

  if (s.type === "callout") {
    ctx.save();
    ctx.beginPath();
    ctx.arc(s.pos.x, s.pos.y, s.radius, 0, Math.PI * 2);
    ctx.fillStyle = s.color;
    ctx.fill();
    ctx.font = `700 ${Math.round(s.radius * 1.2)}px -apple-system, "Segoe UI", system-ui, sans-serif`;
    ctx.fillStyle = "#fff";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(s.number), s.pos.x, s.pos.y);
    ctx.restore();
    return;
  }

  if (s.type === "cursor") {
    drawCursorStamp(ctx, s.pos.x, s.pos.y, s.unit);
    return;
  }

  ctx.save();
  ctx.strokeStyle = s.color;
  ctx.lineWidth = s.width;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  if (s.type === "draw") {
    if (s.points.length >= 2) {
      ctx.beginPath();
      ctx.moveTo(s.points[0].x, s.points[0].y);
      for (let i = 1; i < s.points.length; i++) ctx.lineTo(s.points[i].x, s.points[i].y);
      ctx.stroke();
    }
  } else if (s.type === "arrow") {
    drawArrow(ctx, s.from.x, s.from.y, s.to.x, s.to.y, s.width);
  } else if (s.type === "rect") {
    const x = Math.min(s.from.x, s.to.x), y = Math.min(s.from.y, s.to.y);
    ctx.strokeRect(x, y, Math.abs(s.to.x - s.from.x), Math.abs(s.to.y - s.from.y));
  } else if (s.type === "ellipse") {
    const cx = (s.from.x + s.to.x) / 2, cy = (s.from.y + s.to.y) / 2;
    const rx = Math.abs(s.to.x - s.from.x) / 2, ry = Math.abs(s.to.y - s.from.y) / 2;
    ctx.beginPath();
    ctx.ellipse(cx, cy, Math.max(rx, 0.1), Math.max(ry, 0.1), 0, 0, Math.PI * 2);
    ctx.stroke();
  } else if (s.type === "diamond") {
    const cx = (s.from.x + s.to.x) / 2, cy = (s.from.y + s.to.y) / 2;
    const hw = Math.abs(s.to.x - s.from.x) / 2, hh = Math.abs(s.to.y - s.from.y) / 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy - hh);
    ctx.lineTo(cx + hw, cy);
    ctx.lineTo(cx, cy + hh);
    ctx.lineTo(cx - hw, cy);
    ctx.closePath();
    ctx.stroke();
  } else if (s.type === "line") {
    ctx.beginPath();
    ctx.moveTo(s.from.x, s.from.y);
    ctx.lineTo(s.to.x, s.to.y);
    ctx.stroke();
  }
  ctx.restore();
}

function drawArrow(ctx, x1, y1, x2, y2, lineW) {
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const headLen = Math.max(lineW * 2.5, lineW * 5);

  // Shaft stops at the base of the arrowhead so it cannot poke through.
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2 - headLen * Math.cos(angle), y2 - headLen * Math.sin(angle));
  ctx.stroke();

  ctx.fillStyle = ctx.strokeStyle;
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - headLen * Math.cos(angle - Math.PI / 7), y2 - headLen * Math.sin(angle - Math.PI / 7));
  ctx.lineTo(x2 - headLen * Math.cos(angle + Math.PI / 7), y2 - headLen * Math.sin(angle + Math.PI / 7));
  ctx.closePath();
  ctx.fill();
}

/* Classic arrow pointer stamp, hotspot at the tip. */
function drawCursorStamp(ctx, x, y, unit) {
  ctx.save();
  ctx.translate(x, y);
  ctx.beginPath();
  ctx.moveTo(CURSOR_POINTS[0][0] * unit, CURSOR_POINTS[0][1] * unit);
  for (let i = 1; i < CURSOR_POINTS.length; i++) {
    ctx.lineTo(CURSOR_POINTS[i][0] * unit, CURSOR_POINTS[i][1] * unit);
  }
  ctx.closePath();
  // White body with a soft shadow so it reads on any background.
  ctx.shadowColor = "rgba(0,0,0,0.4)";
  ctx.shadowBlur = 3 * unit;
  ctx.shadowOffsetY = 0.7 * unit;
  ctx.fillStyle = "#ffffff";
  ctx.fill();
  // Crisp dark outline, no shadow on the stroke.
  ctx.shadowColor = "transparent";
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;
  ctx.lineWidth = 1.15 * unit;
  ctx.lineJoin = "round";
  ctx.strokeStyle = "#000000";
  ctx.stroke();
  ctx.restore();
}

/* ───────────────────────── Crop ─────────────────────────
   Picking the crop tool arms a pending rect over the whole visible image
   rather than waiting for a marquee. From there the rect is an ordinary
   editing object: drag a side or a corner to resize it, drag inside it to
   move it, drag outside it to start a fresh one. Nothing reaches state.crop
   until Apply, so the framing can be nudged as many times as it takes instead
   of having to be landed in a single drag.

   The rect is in original source pixels, like everything else in this file,
   and never leaves the region currently on screen: a crop can only take
   pixels away, never bring back ones an earlier crop removed. */
const CROP_MIN = 8;          // smallest crop, in source pixels
const CROP_HANDLE_HIT = 12;  // grab radius for a side or corner, in CSS pixels

const CROP_CURSORS = {
  nw: "nwse-resize", se: "nwse-resize", ne: "nesw-resize", sw: "nesw-resize",
  n: "ns-resize", s: "ns-resize", w: "ew-resize", e: "ew-resize", move: "move",
};

function clamp(v, lo, hi) { return Math.max(lo, Math.min(v, hi)); }

// The region currently on screen: what a new crop is carved out of.
function visibleRect() { return { x: cropX(), y: cropY(), w: srcW(), h: srcH() }; }

function beginCropMode() {
  const v = hasSource() ? visibleRect() : null;
  cropSel = v;
  cropSelBase = v && { ...v };
  cropDrag = null;
  syncCropRow();
  requestPaint();
}

function endCropMode() {
  cropSel = null;
  cropSelBase = null;
  cropDrag = null;
  previewCanvas.style.cursor = "";
  requestPaint();
}

/* Anything that moves the ground under the pending rect (a crop applied,
   undone or reset, a new source) leaves it meaningless, so it starts over at
   full size. Comparing against the region it was seeded from catches all of
   those in one place, without every caller having to remember. */
function refreshCropSel() {
  if (!hasSource()) { cropSel = null; cropSelBase = null; return; }
  const v = visibleRect();
  const b = cropSelBase;
  if (!cropSel || !b || b.x !== v.x || b.y !== v.y || b.w !== v.w || b.h !== v.h) {
    cropSel = v;
    cropSelBase = { ...v };
  }
}

// True when the pending rect would actually trim something off.
function cropSelTrims() {
  if (!cropSel) return false;
  const v = visibleRect();
  return Math.round(cropSel.w) < v.w || Math.round(cropSel.h) < v.h;
}

// Where the pending rect sits on screen, for hit-testing.
function cropSelClient() {
  if (!cropSel) return null;
  const a = sourceToClient(cropSel.x, cropSel.y);
  const b = sourceToClient(cropSel.x + cropSel.w, cropSel.y + cropSel.h);
  if (!a || !b) return null;
  return {
    x0: Math.min(a.x, b.x), y0: Math.min(a.y, b.y),
    x1: Math.max(a.x, b.x), y1: Math.max(a.y, b.y),
  };
}

// Which part of the pending rect is under the pointer: a side, a corner, its
// inside, or nothing at all.
function cropZoneAt(clientX, clientY) {
  const r = cropSelClient();
  if (!r) return null;
  const t = CROP_HANDLE_HIT;
  if (clientX < r.x0 - t || clientX > r.x1 + t) return null;
  if (clientY < r.y0 - t || clientY > r.y1 + t) return null;
  // "n"/"s" and "w"/"e" concatenate into the eight compass handles.
  const zone =
    (Math.abs(clientY - r.y0) <= t ? "n" : Math.abs(clientY - r.y1) <= t ? "s" : "") +
    (Math.abs(clientX - r.x0) <= t ? "w" : Math.abs(clientX - r.x1) <= t ? "e" : "");
  if (zone) return zone;
  return clientX > r.x0 && clientX < r.x1 && clientY > r.y0 && clientY < r.y1 ? "move" : null;
}

/* Apply the live drag to the pending rect. Sides and corners move by the
   pointer's delta from where it grabbed, so the rect does not jump to the
   cursor when a handle is picked up slightly off-centre. */
function dragCropSel(pt) {
  const v = visibleRect();
  const d = cropDrag;
  const o = d.orig;

  if (d.mode === "new") {
    const ax = clamp(d.start.x, v.x, v.x + v.w), bx = clamp(pt.x, v.x, v.x + v.w);
    const ay = clamp(d.start.y, v.y, v.y + v.h), by = clamp(pt.y, v.y, v.y + v.h);
    cropSel = { x: Math.min(ax, bx), y: Math.min(ay, by), w: Math.abs(bx - ax), h: Math.abs(by - ay) };
    syncCropRow();
    return;
  }

  const dx = pt.x - d.start.x, dy = pt.y - d.start.y;
  if (d.mode === "move") {
    cropSel = {
      x: clamp(o.x + dx, v.x, v.x + v.w - o.w),
      y: clamp(o.y + dy, v.y, v.y + v.h - o.h),
      w: o.w, h: o.h,
    };
    syncCropRow();
    return;
  }

  /* Only the eight compass handles reach here, so each letter names an edge.
     A side stops CROP_MIN short of the one opposite it, except on a source too
     small to hold that, where staying inside the image wins instead. */
  let x0 = o.x, y0 = o.y, x1 = o.x + o.w, y1 = o.y + o.h;
  const vx1 = v.x + v.w, vy1 = v.y + v.h;
  if (d.mode.includes("w")) x0 = clamp(o.x + dx, v.x, Math.max(v.x, x1 - CROP_MIN));
  if (d.mode.includes("e")) x1 = clamp(o.x + o.w + dx, Math.min(vx1, x0 + CROP_MIN), vx1);
  if (d.mode.includes("n")) y0 = clamp(o.y + dy, v.y, Math.max(v.y, y1 - CROP_MIN));
  if (d.mode.includes("s")) y1 = clamp(o.y + o.h + dy, Math.min(vy1, y0 + CROP_MIN), vy1);
  cropSel = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  syncCropRow();
}

/* Drawn in scene space (not under the media transform) so the dimming can
   cover the padding as well as the media. */
function drawCropOverlay(ctx, L) {
  if (state.tool !== "crop" || !cropSel) return;
  const a = sourceToScene(cropSel.x, cropSel.y, L);
  const b = sourceToScene(cropSel.x + cropSel.w, cropSel.y + cropSel.h, L);
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  const w = Math.abs(b.x - a.x), h = Math.abs(b.y - a.y);

  ctx.save();
  ctx.fillStyle = "rgba(0,0,0,0.5)";
  ctx.fillRect(0, 0, L.sceneW, y);
  ctx.fillRect(0, y + h, L.sceneW, L.sceneH - (y + h));
  ctx.fillRect(0, y, x, h);
  ctx.fillRect(x + w, y, L.sceneW - (x + w), h);

  const line = Math.max(1, L.baseDim * 0.0015);

  // Thirds guides, to frame against.
  ctx.lineWidth = line;
  ctx.strokeStyle = "rgba(255,255,255,0.3)";
  ctx.beginPath();
  for (let i = 1; i < 3; i++) {
    ctx.moveTo(x + (w * i) / 3, y);
    ctx.lineTo(x + (w * i) / 3, y + h);
    ctx.moveTo(x, y + (h * i) / 3);
    ctx.lineTo(x + w, y + (h * i) / 3);
  }
  ctx.stroke();

  ctx.strokeStyle = "rgba(255,255,255,0.9)";
  ctx.strokeRect(x, y, w, h);

  // Grab handles: brackets on the corners, short bars on the sides. Capped
  // against the rect so they stay proportionate on a small crop.
  const grip = Math.min(Math.max(L.baseDim * 0.025, line * 7), w / 3, h / 3);
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = line * 3;
  ctx.lineCap = "butt";
  ctx.beginPath();
  ctx.moveTo(x, y + grip); ctx.lineTo(x, y); ctx.lineTo(x + grip, y);
  ctx.moveTo(x + w - grip, y); ctx.lineTo(x + w, y); ctx.lineTo(x + w, y + grip);
  ctx.moveTo(x + w, y + h - grip); ctx.lineTo(x + w, y + h); ctx.lineTo(x + w - grip, y + h);
  ctx.moveTo(x + grip, y + h); ctx.lineTo(x, y + h); ctx.lineTo(x, y + h - grip);
  ctx.moveTo(x + w / 2 - grip / 2, y); ctx.lineTo(x + w / 2 + grip / 2, y);
  ctx.moveTo(x + w / 2 - grip / 2, y + h); ctx.lineTo(x + w / 2 + grip / 2, y + h);
  ctx.moveTo(x, y + h / 2 - grip / 2); ctx.lineTo(x, y + h / 2 + grip / 2);
  ctx.moveTo(x + w, y + h / 2 - grip / 2); ctx.lineTo(x + w, y + h / 2 + grip / 2);
  ctx.stroke();
  ctx.restore();
}

/* Commit a rect to state.crop, intersected with what is currently visible so
   a drag past the edge trims to the edge rather than revealing pixels an
   earlier crop had already removed. */
function applyCrop(rect) {
  const v = visibleRect();
  const x = Math.round(clamp(rect.x, v.x, v.x + v.w));
  const y = Math.round(clamp(rect.y, v.y, v.y + v.h));
  const w = Math.round(clamp(rect.x + rect.w, v.x, v.x + v.w)) - x;
  const h = Math.round(clamp(rect.y + rect.h, v.y, v.y + v.h)) - y;
  if (!(w >= CROP_MIN && h >= CROP_MIN)) return; // too small to be meant (or NaN)
  if (w === v.w && h === v.h) return;            // nothing to trim
  pushHistory();
  state.crop = { x, y, w, h };
  markDirty();
  syncAnnotationUI();
  requestPaint();
}

function commitCropSel() {
  if (cropSel) applyCrop(cropSel);
}

// Escape backs out of a pending rect before it backs out of the tool.
function cancelCropSel() {
  if (!cropSelTrims()) return false;
  beginCropMode();
  return true;
}

/* ───────────────────────── Text entry ─────────────────────────
   A real <input> floated over the canvas, so typing behaves natively. It is
   positioned in client space and converted back to source pixels on commit. */
// `existing` re-opens the input over a text stroke already on the image, which
// is the only way to fix a typo without undoing everything drawn since.
function spawnTextInput(pt, existing) {
  const L = layout();
  const fit = previewFit(L);
  const cam = cameraAt(currentTime());
  const anchor = existing ? existing.pos : pt;
  const fontPx = existing ? existing.fontPx : TEXT_FRAC[state.textSize] * baseDim();
  const color = existing ? existing.color : state.color;
  const screenFont = Math.max(9, fontPx * fit * cam.scale);
  const at = sourceToClient(anchor.x, anchor.y);
  if (!at) return;

  const input = document.createElement("input");
  input.type = "text";
  input.className = "annot-text-input";
  input.style.left = at.x + "px";
  input.style.top = (at.y - screenFont * 0.75) + "px";
  input.style.fontSize = screenFont + "px";
  input.style.color = color;
  if (existing) input.value = existing.text;
  document.body.appendChild(input);
  input.focus();
  input.select();

  let cancelled = false;

  function commit() {
    const text = input.value.trim();
    input.remove();
    if (cancelled) return;

    if (existing) {
      if (text === existing.text) return;
      pushHistory();
      if (!text) {
        // Emptying the field is how you delete the label.
        state.strokes = state.strokes.filter((s) => s.id !== existing.id);
        state.selectedStrokeId = null;
      } else {
        replaceStroke({ ...existing, text });
      }
      markDirty();
      syncAnnotationUI();
      requestPaint();
      return;
    }

    if (!text) return;
    commitStroke({ type: "text", text, pos: { x: anchor.x, y: anchor.y }, color, fontPx });
  }

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); commit(); }
    if (e.key === "Escape") { e.preventDefault(); cancelled = true; input.remove(); }
    e.stopPropagation();
  });
  input.addEventListener("blur", () => { if (!cancelled) commit(); });
}

/* ───────────────────────── Selection & editing ─────────────────────────
   Strokes are committed as immutable objects with a stable id. The pointer
   tool (V) selects one, and every edit REPLACES the object rather than
   mutating it, which is what lets the undo snapshot stay a shallow array copy:
   the snapshot keeps pointing at the pre-edit object.

   Geometry is all in source pixels, like the rest of this file, so hit tests
   and handles survive a crop, a zoom or a window resize. Grab tolerances are
   the one thing measured on screen, because a fat finger is a fat finger
   whatever the image resolution. */
const SELECT_HIT_CSS = 8;     // grab tolerance around a stroke, in CSS pixels
const SELECT_HANDLE_CSS = 10; // grab radius for a resize handle
// Types with no natural width and height of their own, which therefore scale
// uniformly from a corner rather than resizing edge by edge.
const SCALE_ONLY = new Set(["draw", "text", "callout", "cursor"]);
const ENDPOINT_TOOLS = new Set(["arrow", "line"]);
const STROKE_LABELS = {
  draw: "Drawing", arrow: "Arrow", rect: "Rectangle", ellipse: "Ellipse",
  diamond: "Diamond", line: "Line", text: "Text", redact: "Redaction",
  callout: "Callout", cursor: "Cursor",
};

let strokeSeq = 0;
let selectDrag = null; // { mode: "move" | "resize", grip, start, orig }
let measureCtx = null;

function nextStrokeId() { return ++strokeSeq; }

function selectedStroke() {
  if (state.selectedStrokeId == null) return null;
  return state.strokes.find((s) => s.id === state.selectedStrokeId) || null;
}

function selectStroke(id) {
  if (state.selectedStrokeId === id) return;
  state.selectedStrokeId = id;
  syncAnnotationUI();
  requestPaint();
}

// Source pixels per CSS pixel on screen, so an on-screen tolerance can be
// expressed in the coordinate space the strokes actually live in.
function sourcePerClientPx() {
  const L = layout();
  const fit = previewFit(L);
  if (!fit) return 1;
  const cam = cameraAt(currentTime());
  return 1 / (fit * (cam.scale || 1));
}

function textFont(s) {
  return `600 ${s.fontPx}px -apple-system, "Segoe UI", system-ui, sans-serif`;
}

function measureTextWidth(s) {
  if (!measureCtx) measureCtx = document.createElement("canvas").getContext("2d");
  measureCtx.font = textFont(s);
  return measureCtx.measureText(s.text || "").width;
}

/* ── Bounds ── */
function strokeBounds(s) {
  if (s.type === "draw") {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of s.points) {
      if (p.x < x0) x0 = p.x;
      if (p.y < y0) y0 = p.y;
      if (p.x > x1) x1 = p.x;
      if (p.y > y1) y1 = p.y;
    }
    if (!Number.isFinite(x0)) return { x: 0, y: 0, w: 0, h: 0 };
    const pad = (s.width || 1) / 2;
    return { x: x0 - pad, y: y0 - pad, w: x1 - x0 + pad * 2, h: y1 - y0 + pad * 2 };
  }

  if (s.type === "text") {
    const w = measureTextWidth(s);
    // fillText is drawn with a "middle" baseline, so the box straddles pos.y.
    return { x: s.pos.x, y: s.pos.y - s.fontPx * 0.62, w, h: s.fontPx * 1.24 };
  }

  if (s.type === "callout") {
    return { x: s.pos.x - s.radius, y: s.pos.y - s.radius, w: s.radius * 2, h: s.radius * 2 };
  }

  if (s.type === "cursor") {
    let x1 = 0, y1 = 0;
    for (const p of CURSOR_POINTS) {
      if (p[0] > x1) x1 = p[0];
      if (p[1] > y1) y1 = p[1];
    }
    return { x: s.pos.x, y: s.pos.y, w: x1 * s.unit, h: y1 * s.unit };
  }

  const pad = s.type === "redact" ? 0 : (s.width || 1) / 2;
  const x = Math.min(s.from.x, s.to.x) - pad;
  const y = Math.min(s.from.y, s.to.y) - pad;
  return {
    x, y,
    w: Math.abs(s.to.x - s.from.x) + pad * 2,
    h: Math.abs(s.to.y - s.from.y) + pad * 2,
  };
}

/* ── Hit testing ── */
function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function nearPolyline(pt, pts, tol, close) {
  for (let i = 1; i < pts.length; i++) {
    if (distToSegment(pt.x, pt.y, pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]) <= tol) return true;
  }
  if (close && pts.length > 2) {
    const a = pts[pts.length - 1], b = pts[0];
    if (distToSegment(pt.x, pt.y, a[0], a[1], b[0], b[1]) <= tol) return true;
  }
  return false;
}

function insideBounds(pt, b, tol) {
  return pt.x >= b.x - tol && pt.x <= b.x + b.w + tol &&
         pt.y >= b.y - tol && pt.y <= b.y + b.h + tol;
}

function hitStroke(s, pt, tol) {
  const lw = (s.width || 1) / 2;

  if (s.type === "draw") {
    if (s.points.length === 1) return Math.hypot(pt.x - s.points[0].x, pt.y - s.points[0].y) <= lw + tol;
    for (let i = 1; i < s.points.length; i++) {
      const a = s.points[i - 1], b = s.points[i];
      if (distToSegment(pt.x, pt.y, a.x, a.y, b.x, b.y) <= lw + tol) return true;
    }
    return false;
  }

  if (s.type === "arrow" || s.type === "line") {
    return distToSegment(pt.x, pt.y, s.from.x, s.from.y, s.to.x, s.to.y) <= lw + tol;
  }

  // Hollow shapes are grabbed by their outline: clicking through the middle of
  // an empty rectangle should reach whatever is behind it.
  if (s.type === "rect") {
    const x0 = Math.min(s.from.x, s.to.x), y0 = Math.min(s.from.y, s.to.y);
    const x1 = Math.max(s.from.x, s.to.x), y1 = Math.max(s.from.y, s.to.y);
    return nearPolyline(pt, [[x0, y0], [x1, y0], [x1, y1], [x0, y1]], lw + tol, true);
  }

  if (s.type === "diamond") {
    const cx = (s.from.x + s.to.x) / 2, cy = (s.from.y + s.to.y) / 2;
    const hw = Math.abs(s.to.x - s.from.x) / 2, hh = Math.abs(s.to.y - s.from.y) / 2;
    return nearPolyline(pt, [[cx, cy - hh], [cx + hw, cy], [cx, cy + hh], [cx - hw, cy]], lw + tol, true);
  }

  if (s.type === "ellipse") {
    const cx = (s.from.x + s.to.x) / 2, cy = (s.from.y + s.to.y) / 2;
    const rx = Math.max(Math.abs(s.to.x - s.from.x) / 2, 0.1);
    const ry = Math.max(Math.abs(s.to.y - s.from.y) / 2, 0.1);
    const nx = (pt.x - cx) / rx, ny = (pt.y - cy) / ry;
    const r = Math.hypot(nx, ny);
    // Scale the normalized error back to source pixels along the tighter axis.
    return Math.abs(r - 1) * Math.min(rx, ry) <= lw + tol;
  }

  if (s.type === "callout") {
    return Math.hypot(pt.x - s.pos.x, pt.y - s.pos.y) <= s.radius + tol;
  }

  // redact, text and cursor are solid: anywhere in the box counts.
  return insideBounds(pt, strokeBounds(s), tol);
}

// Topmost stroke first, matching paint order.
function strokeAt(pt, tol) {
  for (let i = state.strokes.length - 1; i >= 0; i--) {
    if (hitStroke(state.strokes[i], pt, tol)) return state.strokes[i];
  }
  return null;
}

/* ── Handles ── */
function strokeHandles(s) {
  if (ENDPOINT_TOOLS.has(s.type)) {
    return [
      { key: "from", x: s.from.x, y: s.from.y },
      { key: "to", x: s.to.x, y: s.to.y },
    ];
  }
  const b = strokeBounds(s);
  const all = [
    { key: "nw", x: b.x, y: b.y },
    { key: "ne", x: b.x + b.w, y: b.y },
    { key: "se", x: b.x + b.w, y: b.y + b.h },
    { key: "sw", x: b.x, y: b.y + b.h },
    { key: "n", x: b.x + b.w / 2, y: b.y },
    { key: "e", x: b.x + b.w, y: b.y + b.h / 2 },
    { key: "s", x: b.x + b.w / 2, y: b.y + b.h },
    { key: "w", x: b.x, y: b.y + b.h / 2 },
  ];
  // Uniform-scale types only offer corners; a mid-edge grip would imply a
  // stretch they cannot represent.
  return SCALE_ONLY.has(s.type) ? all.slice(0, 4) : all;
}

function handleAtPoint(s, pt, tol) {
  for (const h of strokeHandles(s)) {
    if (Math.abs(pt.x - h.x) <= tol && Math.abs(pt.y - h.y) <= tol) return h;
  }
  return null;
}

/* ── Edits (all return a NEW stroke) ── */
function translateStroke(s, dx, dy) {
  if (s.type === "draw") {
    return { ...s, points: s.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) };
  }
  if (s.pos) return { ...s, pos: { x: s.pos.x + dx, y: s.pos.y + dy } };
  return {
    ...s,
    from: { x: s.from.x + dx, y: s.from.y + dy },
    to: { x: s.to.x + dx, y: s.to.y + dy },
  };
}

function scaleStroke(s, factor, anchor) {
  const f = Math.max(0.05, Math.min(20, factor));
  const at = (p) => ({ x: anchor.x + (p.x - anchor.x) * f, y: anchor.y + (p.y - anchor.y) * f });
  if (s.type === "draw") {
    return { ...s, points: s.points.map(at), width: Math.max(0.5, s.width * f) };
  }
  if (s.type === "text") return { ...s, pos: at(s.pos), fontPx: Math.max(4, s.fontPx * f) };
  if (s.type === "callout") return { ...s, pos: at(s.pos), radius: Math.max(2, s.radius * f) };
  if (s.type === "cursor") return { ...s, pos: at(s.pos), unit: Math.max(0.05, s.unit * f) };
  return s;
}

// Resize a box-shaped stroke by moving one edge or corner.
function resizeBoxStroke(s, grip, pt) {
  let x0 = Math.min(s.from.x, s.to.x), y0 = Math.min(s.from.y, s.to.y);
  let x1 = Math.max(s.from.x, s.to.x), y1 = Math.max(s.from.y, s.to.y);
  if (grip.includes("w")) x0 = pt.x;
  if (grip.includes("e")) x1 = pt.x;
  if (grip.includes("n")) y0 = pt.y;
  if (grip.includes("s")) y1 = pt.y;
  return { ...s, from: { x: Math.min(x0, x1), y: Math.min(y0, y1) },
                 to: { x: Math.max(x0, x1), y: Math.max(y0, y1) } };
}

function replaceStroke(next) {
  const i = state.strokes.findIndex((s) => s.id === next.id);
  if (i !== -1) state.strokes[i] = next;
}

function deleteSelectedStroke() {
  const s = selectedStroke();
  if (!s) return false;
  pushHistory();
  state.strokes = state.strokes.filter((k) => k.id !== s.id);
  state.selectedStrokeId = null;
  markDirty();
  syncAnnotationUI();
  requestPaint();
  return true;
}

// Push a property change (colour, text size, redaction style) onto whatever is
// selected, so the option rows edit the existing mark instead of only setting
// the default for the next one.
function updateSelectedStroke(patch) {
  const s = selectedStroke();
  if (!s) return false;
  const next = { ...s, ...patch };
  pushHistory();
  replaceStroke(next);
  markDirty();
  requestPaint();
  return true;
}

/* ── Pointer, pointer tool ──
   History is pushed on the first pixel of actual movement, never on mousedown:
   pushHistory also clears the redo stack, so arming it for a click that turns
   out to only select something would throw away a redo the user still had. */
function selectPointerDown(e, pt) {
  const tol = sourcePerClientPx();
  const current = selectedStroke();

  if (current) {
    const grip = handleAtPoint(current, pt, SELECT_HANDLE_CSS * tol);
    if (grip) {
      selectDrag = { mode: "resize", grip: grip.key, start: pt, orig: current, pushed: false };
      isDrawing = true;
      try { previewCanvas.setPointerCapture(e.pointerId); } catch (_) {}
      return true;
    }
  }

  const hit = strokeAt(pt, SELECT_HIT_CSS * tol);
  if (!hit) {
    selectStroke(null);
    return false;
  }

  if (!current || hit.id !== current.id) selectStroke(hit.id);
  selectDrag = { mode: "move", start: pt, orig: selectedStroke(), pushed: false };
  isDrawing = true;
  try { previewCanvas.setPointerCapture(e.pointerId); } catch (_) {}
  return true;
}

// Snapshot once, immediately before the first mutation of this gesture.
function armSelectHistory(d) {
  if (d.pushed) return;
  d.pushed = true;
  pushHistory();
}

function selectPointerMove(pt) {
  const d = selectDrag;
  const s = d.orig;

  if (d.mode === "move") {
    const dx = pt.x - d.start.x, dy = pt.y - d.start.y;
    if (!d.pushed && Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;
    armSelectHistory(d);
    replaceStroke(translateStroke(s, dx, dy));
    return;
  }

  if (ENDPOINT_TOOLS.has(s.type)) {
    armSelectHistory(d);
    replaceStroke(d.grip === "from" ? { ...s, from: pt } : { ...s, to: pt });
    return;
  }

  if (SCALE_ONLY.has(s.type)) {
    // Scale about the corner opposite the one being dragged.
    const b = strokeBounds(s);
    const anchor = {
      x: d.grip.includes("w") ? b.x + b.w : b.x,
      y: d.grip.includes("n") ? b.y + b.h : b.y,
    };
    const grip = strokeHandles(s).find((h) => h.key === d.grip);
    if (!grip) return;
    const base = Math.hypot(grip.x - anchor.x, grip.y - anchor.y);
    if (base < 0.001) return;
    armSelectHistory(d);
    replaceStroke(scaleStroke(s, Math.hypot(pt.x - anchor.x, pt.y - anchor.y) / base, anchor));
    return;
  }

  armSelectHistory(d);
  replaceStroke(resizeBoxStroke(s, d.grip, pt));
}

function selectPointerUp() {
  const d = selectDrag;
  selectDrag = null;
  if (!d) return;
  if (d.pushed) markDirty();
  syncAnnotationUI();
  requestPaint();
}

// Cursor feedback while the pointer tool is hovering.
function selectHover(e) {
  const pt = clientToSource(e.clientX, e.clientY);
  if (!pt) { previewCanvas.style.cursor = ""; return; }
  const tol = sourcePerClientPx();
  const current = selectedStroke();
  if (current) {
    const grip = handleAtPoint(current, pt, SELECT_HANDLE_CSS * tol);
    if (grip) {
      previewCanvas.style.cursor = ENDPOINT_TOOLS.has(current.type)
        ? "crosshair"
        : (CROP_CURSORS[grip.key] || "move");
      return;
    }
  }
  previewCanvas.style.cursor = strokeAt(pt, SELECT_HIT_CSS * tol) ? "move" : "";
}

/* Selection chrome, painted over the finished scene the way the crop rect is,
   so it never reaches an export. Drawn in scene units. */
function drawSelectionOverlay(ctx, L) {
  if (state.tool !== "none") return;
  const s = selectedStroke();
  if (!s) return;
  const fit = previewFit(L);
  if (!fit) return;
  const px = 1 / fit; // scene units per CSS pixel

  const b = strokeBounds(s);
  const a = sourceToScene(b.x, b.y, L);
  const c = sourceToScene(b.x + b.w, b.y + b.h, L);
  const x = Math.min(a.x, c.x), y = Math.min(a.y, c.y);
  const w = Math.abs(c.x - a.x), h = Math.abs(c.y - a.y);

  ctx.save();
  ctx.lineWidth = px;
  ctx.setLineDash([4 * px, 3 * px]);
  ctx.strokeStyle = "rgba(0,0,0,0.55)";
  ctx.strokeRect(x - px, y - px, w + px * 2, h + px * 2);
  ctx.strokeStyle = "rgba(255,255,255,0.95)";
  ctx.strokeRect(x, y, w, h);
  ctx.setLineDash([]);

  const half = 3.5 * px;
  for (const g of strokeHandles(s)) {
    const p = sourceToScene(g.x, g.y, L);
    ctx.fillStyle = "#ffffff";
    ctx.strokeStyle = "rgba(0,0,0,0.55)";
    ctx.lineWidth = px;
    ctx.beginPath();
    ctx.rect(p.x - half, p.y - half, half * 2, half * 2);
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

/* ───────────────────────── Pointer input ───────────────────────── */
function annotationPointerDown(e) {
  // Left button only. A middle-click starts a pan on the preview area, and
  // taking pointer capture for it here would strand the stroke: the matching
  // pointerup never arrives and the mark follows the cursor with no button held.
  if (e.button !== 0) return false;
  if (!hasSource()) return false;
  const pt = clientToSource(e.clientX, e.clientY);
  if (!pt) return false;

  // The pointer tool selects and edits what is already there.
  if (state.tool === "none") return selectPointerDown(e, pt);

  if (state.tool === "text") { spawnTextInput(pt); return true; }

  if (state.tool === "callout") {
    // Only burn a number once the stroke is actually accepted, so hitting the
    // stroke limit does not leave a gap in the sequence.
    const added = commitStroke({
      type: "callout",
      pos: pt,
      number: state.calloutCounter,
      color: state.color,
      radius: CALLOUT_FRAC * baseDim(),
    });
    if (added) state.calloutCounter++;
    return true;
  }

  if (state.tool === "cursor") {
    commitStroke({ type: "cursor", pos: pt, unit: CURSOR_STAMP_FRAC * baseDim() });
    return true;
  }

  /* Crop: grabbing the pending rect adjusts it, starting outside it draws a
     new one. Either way nothing is committed until Apply. */
  if (state.tool === "crop") {
    if (!cropSel) beginCropMode();
    if (!cropSel) return false;
    isDrawing = true;
    try { previewCanvas.setPointerCapture(e.pointerId); } catch (_) {}
    const zone = cropZoneAt(e.clientX, e.clientY);
    cropDrag = { mode: zone || "new", start: pt, orig: { ...cropSel } };
    if (!zone) cropSel = { x: pt.x, y: pt.y, w: 0, h: 0 };
    requestPaint();
    return true;
  }

  isDrawing = true;
  try { previewCanvas.setPointerCapture(e.pointerId); } catch (_) {}

  const width = STROKE_FRAC * baseDim();
  if (state.tool === "draw") {
    currentStroke = { type: "draw", points: [pt], color: state.color, width };
  } else if (state.tool === "arrow") {
    currentStroke = { type: "arrow", from: pt, to: { ...pt }, color: state.color, width };
  } else if (SHAPE_TOOLS.has(state.tool)) {
    currentStroke = { type: state.tool, from: pt, to: { ...pt }, color: state.color, width };
  } else if (state.tool === "redact") {
    currentStroke = {
      type: "redact", from: pt, to: { ...pt },
      style: state.redactStyle,
      block: PIXEL_FRAC[state.pixelSize] * baseDim(),
    };
  }
  requestPaint();
  return true;
}

function annotationPointerMove(e) {
  // Hovering in crop mode: show what grabbing here would do.
  if (state.tool === "crop" && !cropDrag) {
    const zone = cropZoneAt(e.clientX, e.clientY);
    previewCanvas.style.cursor = zone ? CROP_CURSORS[zone] : "crosshair";
    return;
  }
  // Same idea for the pointer tool: show whether this spot grabs anything.
  if (state.tool === "none" && !selectDrag) {
    selectHover(e);
    return;
  }
  if (!isDrawing) return;
  const pt = clientToSource(e.clientX, e.clientY);
  if (!pt) return;
  if (selectDrag) { selectPointerMove(pt); requestPaint(); return; }
  if (cropDrag) dragCropSel(pt);
  else if (currentStroke && currentStroke.type === "draw") currentStroke.points.push(pt);
  else if (currentStroke) currentStroke.to = pt;
  requestPaint();
}

function annotationPointerUp(e) {
  if (!isDrawing) return;
  isDrawing = false;
  try { previewCanvas.releasePointerCapture(e.pointerId); } catch (_) {}

  if (selectDrag) { selectPointerUp(); return; }

  if (cropDrag) {
    // A stray click, or a marquee too small to have been meant, leaves the
    // rect as it was rather than wiping out a selection already made.
    if (cropSel.w < CROP_MIN || cropSel.h < CROP_MIN) cropSel = cropDrag.orig;
    cropDrag = null;
    syncCropRow();
    requestPaint();
    return;
  }
  if (!currentStroke) return;

  // Only keep strokes with meaningful content.
  const s = currentStroke;
  currentStroke = null;
  const minDrag = Math.max(2, baseDim() * 0.002);
  let keep;
  if (s.type === "draw") keep = s.points.length >= 2;
  else keep = Math.abs(s.to.x - s.from.x) > minDrag || Math.abs(s.to.y - s.from.y) > minDrag;
  if (keep) commitStroke(s);
  else requestPaint();
}

/* ───────────────────────── Tool rail ───────────────────────── */
function selectTool(t) {
  const leavingCrop = state.tool === "crop";
  // The selection belongs to the pointer tool; anything else drops it.
  if (t !== "none") {
    state.selectedStrokeId = null;
    selectDrag = null;
  }
  previewCanvas.style.cursor = "";
  state.tool = t;
  document.querySelectorAll("[data-tool]").forEach((b) => {
    b.classList.toggle("active", b.dataset.tool === t);
  });
  const shapeBtn = document.getElementById("shapeBtn");
  shapeBtn.classList.toggle("active", SHAPE_TOOLS.has(t));
  document.getElementById("shapeDropdown").classList.remove("open");
  previewArea.classList.toggle("drawing", t !== "none");
  // Picking crop arms a full-size rect straight away, so there is always
  // something on screen to drag rather than a blank canvas to guess at.
  if (t === "crop") beginCropMode();
  else if (leavingCrop) endCropMode();
  syncAnnotationUI();
  // The render loop only runs on demand, so dropping the selection above has to
  // ask for the repaint that takes its box off screen.
  requestPaint();
}

// Size readout and Apply state for the crop row, refreshed on every drag.
function syncCropRow() {
  const row = document.getElementById("cropRow");
  if (!row) return;
  row.classList.toggle("hidden", state.tool !== "crop");
  if (state.tool !== "crop") return;
  const v = visibleRect();
  const w = cropSel ? Math.round(cropSel.w) : v.w;
  const h = cropSel ? Math.round(cropSel.h) : v.h;
  document.getElementById("cropDims").textContent = w + " × " + h;
  document.getElementById("applyCropBtn").disabled = !cropSelTrims();
}

// Show only the option row(s) the active tool actually uses, plus, when the
// pointer tool has something selected, the rows that would edit it.
function syncAnnotationUI() {
  const t = state.tool;
  if (t === "crop") refreshCropSel();
  const sel = t === "none" ? selectedStroke() : null;
  const selType = sel ? sel.type : null;

  document.getElementById("textSizeRow")
    .classList.toggle("hidden", !(t === "text" || selType === "text"));
  document.getElementById("redactStyleRow")
    .classList.toggle("hidden", !(t === "redact" || selType === "redact"));
  const pixelRow = (t === "redact" && state.redactStyle === "pixelate") ||
                   (selType === "redact" && sel.style === "pixelate");
  document.getElementById("pixelSizeRow").classList.toggle("hidden", !pixelRow);
  // Colour applies to everything except redactions (always black) and the
  // cursor stamp (always the system pointer).
  const colorRow = (t !== "none" && t !== "crop" && t !== "cursor") ||
                   (!!sel && selType !== "redact" && selType !== "cursor");
  document.getElementById("colorRow").classList.toggle("hidden", !colorRow);

  const selRow = document.getElementById("selectionRow");
  if (selRow) {
    selRow.classList.toggle("hidden", !sel);
    if (sel) {
      document.getElementById("selectionLabel").textContent = STROKE_LABELS[selType] || "Selected";
    }
  }
  syncCropRow();
  document.getElementById("undoBtn").disabled = undoStack.length === 0;
  document.getElementById("redoBtn").disabled = redoStack.length === 0;
  const resetBtn = document.getElementById("resetCropBtn");
  if (resetBtn) resetBtn.classList.toggle("hidden", !state.crop);
}

const SHAPE_ICONS = {
  rect: '<rect x="3" y="3" width="18" height="18" rx="2"/>',
  ellipse: '<ellipse cx="12" cy="12" rx="9" ry="7"/>',
  diamond: '<polygon points="12 2, 22 12, 12 22, 2 12"/>',
  line: '<line x1="4" y1="20" x2="20" y2="4"/>',
};

function initAnnotationUI() {
  const shapeBtn = document.getElementById("shapeBtn");
  const shapeDropdown = document.getElementById("shapeDropdown");
  const shapeIcon = document.getElementById("shapeIcon");

  shapeBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (SHAPE_TOOLS.has(state.tool)) shapeDropdown.classList.toggle("open");
    else selectTool(state.shapeType);
  });
  document.querySelectorAll("[data-shape]").forEach((opt) => {
    opt.addEventListener("click", (e) => {
      e.stopPropagation();
      document.querySelectorAll("[data-shape]").forEach((o) => o.classList.toggle("active", o === opt));
      state.shapeType = opt.dataset.shape;
      shapeIcon.innerHTML = SHAPE_ICONS[state.shapeType];
      selectTool(state.shapeType);
    });
  });
  document.addEventListener("click", () => shapeDropdown.classList.remove("open"));

  document.querySelectorAll("[data-tool]").forEach((btn) => {
    btn.addEventListener("click", () => selectTool(btn.dataset.tool));
  });

  /* The option rows set the default for the next mark, and also edit the
     selected one, so restyling something already drawn does not mean undoing
     it and drawing it again. */
  document.querySelectorAll("[data-annot-color]").forEach((sw) => {
    sw.addEventListener("click", () => {
      document.querySelectorAll("[data-annot-color]").forEach((s) => s.classList.toggle("active", s === sw));
      state.color = sw.dataset.annotColor;
      const sel = selectedStroke();
      if (sel && sel.type !== "redact" && sel.type !== "cursor") {
        updateSelectedStroke({ color: state.color });
      }
    });
  });

  document.querySelectorAll("[data-textsize]").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("[data-textsize]").forEach((b) => b.classList.toggle("active", b === btn));
      state.textSize = btn.dataset.textsize;
      const sel = selectedStroke();
      if (sel && sel.type === "text") {
        updateSelectedStroke({ fontPx: TEXT_FRAC[state.textSize] * baseDim() });
      }
    });
  });
  document.querySelectorAll("[data-pixel]").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("[data-pixel]").forEach((b) => b.classList.toggle("active", b === btn));
      state.pixelSize = btn.dataset.pixel;
      const sel = selectedStroke();
      if (sel && sel.type === "redact") {
        updateSelectedStroke({ block: PIXEL_FRAC[state.pixelSize] * baseDim() });
      }
    });
  });
  document.querySelectorAll("[data-redact]").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("[data-redact]").forEach((b) => b.classList.toggle("active", b === btn));
      state.redactStyle = btn.dataset.redact;
      const sel = selectedStroke();
      if (sel && sel.type === "redact") updateSelectedStroke({ style: state.redactStyle });
      syncAnnotationUI();
    });
  });

  document.getElementById("applyCropBtn").addEventListener("click", commitCropSel);
  previewCanvas.addEventListener("dblclick", (e) => {
    // Double-clicking the rect is the other way to say "this one".
    if (state.tool === "crop" && cropZoneAt(e.clientX, e.clientY)) { commitCropSel(); return; }
    // Double-clicking a text label reopens it for editing.
    if (state.tool !== "none") return;
    const pt = clientToSource(e.clientX, e.clientY);
    if (!pt) return;
    const hit = strokeAt(pt, SELECT_HIT_CSS * sourcePerClientPx());
    if (hit && hit.type === "text") {
      selectStroke(hit.id);
      spawnTextInput(null, hit);
    }
  });

  document.getElementById("deleteStrokeBtn").addEventListener("click", deleteSelectedStroke);

  document.getElementById("undoBtn").addEventListener("click", undo);
  document.getElementById("redoBtn").addEventListener("click", redo);
  document.getElementById("resetCropBtn").addEventListener("click", () => {
    if (!state.crop) return;
    pushHistory();
    state.crop = null;
    markDirty();
    syncAnnotationUI();
    requestPaint();
  });

  syncAnnotationUI();
}
