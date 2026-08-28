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
let cropSel = null;         // live crop marquee, never saved

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
  state.strokes.push(s);
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

    // Pixelate by sampling the source at reduced resolution and scaling back up
    // with smoothing off. Sampling the element (not the canvas) keeps the block
    // grid stable no matter how the preview is scaled.
    if (!sourceReady()) { ctx.fillStyle = "#000"; ctx.fillRect(x, y, w, h); return; }
    const block = Math.max(1, s.block);
    const cols = Math.max(1, Math.ceil(w / block));
    const rows = Math.max(1, Math.ceil(h / block));
    const tmp = document.createElement("canvas");
    tmp.width = cols;
    tmp.height = rows;
    try {
      tmp.getContext("2d").drawImage(source.el, x, y, w, h, 0, 0, cols, rows);
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

/* ───────────────────────── Crop marquee ─────────────────────────
   Drawn in scene space (not under the media transform) so the dimming can
   cover the padding as well as the media. */
function drawCropOverlay(ctx, L) {
  if (!cropSel) return;
  const a = sourceToScene(cropSel.from.x, cropSel.from.y, L);
  const b = sourceToScene(cropSel.to.x, cropSel.to.y, L);
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  const w = Math.abs(b.x - a.x), h = Math.abs(b.y - a.y);
  ctx.save();
  ctx.fillStyle = "rgba(0,0,0,0.45)";
  ctx.fillRect(0, 0, L.sceneW, y);
  ctx.fillRect(0, y + h, L.sceneW, L.sceneH - (y + h));
  ctx.fillRect(0, y, x, h);
  ctx.fillRect(x + w, y, L.sceneW - (x + w), h);
  ctx.strokeStyle = "rgba(255,255,255,0.95)";
  ctx.lineWidth = Math.max(1, L.baseDim * 0.0015);
  ctx.setLineDash([L.baseDim * 0.008, L.baseDim * 0.006]);
  ctx.strokeRect(x, y, w, h);
  ctx.restore();
}

// Commit a marquee to state.crop, intersected with what is currently visible.
function applyCrop(sel) {
  const x0 = Math.min(sel.from.x, sel.to.x);
  const y0 = Math.min(sel.from.y, sel.to.y);
  const x1 = Math.max(sel.from.x, sel.to.x);
  const y1 = Math.max(sel.from.y, sel.to.y);
  // Clamp to the region currently on screen, so a drag past the edge trims to
  // the edge rather than revealing pixels the crop had already removed.
  const vx0 = cropX(), vy0 = cropY();
  const vx1 = vx0 + srcW(), vy1 = vy0 + srcH();
  const nx = Math.round(Math.max(vx0, Math.min(x0, vx1)));
  const ny = Math.round(Math.max(vy0, Math.min(y0, vy1)));
  const nw = Math.round(Math.max(vx0, Math.min(x1, vx1))) - nx;
  const nh = Math.round(Math.max(vy0, Math.min(y1, vy1))) - ny;
  if (nw < 8 || nh < 8) return; // ignore tiny selections
  pushHistory();
  state.crop = { x: nx, y: ny, w: nw, h: nh };
  markDirty();
  syncAnnotationUI();
  requestPaint();
}

/* ───────────────────────── Text entry ─────────────────────────
   A real <input> floated over the canvas, so typing behaves natively. It is
   positioned in client space and converted back to source pixels on commit. */
function spawnTextInput(pt) {
  const L = layout();
  const fit = previewFit(L);
  const cam = cameraAt(currentTime());
  const fontPx = TEXT_FRAC[state.textSize] * baseDim();
  const screenFont = Math.max(9, fontPx * fit * cam.scale);
  const at = sourceToClient(pt.x, pt.y);
  if (!at) return;

  const input = document.createElement("input");
  input.type = "text";
  input.className = "annot-text-input";
  input.style.left = at.x + "px";
  input.style.top = (at.y - screenFont * 0.75) + "px";
  input.style.fontSize = screenFont + "px";
  input.style.color = state.color;
  document.body.appendChild(input);
  input.focus();

  const color = state.color;
  let cancelled = false;

  function commit() {
    const text = input.value.trim();
    input.remove();
    if (!text || cancelled) return;
    commitStroke({ type: "text", text, pos: { x: pt.x, y: pt.y }, color, fontPx });
  }

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); commit(); }
    if (e.key === "Escape") { e.preventDefault(); cancelled = true; input.remove(); }
    e.stopPropagation();
  });
  input.addEventListener("blur", () => { if (!cancelled) commit(); });
}

/* ───────────────────────── Pointer input ───────────────────────── */
function annotationPointerDown(e) {
  if (state.tool === "none" || !hasSource()) return false;
  const pt = clientToSource(e.clientX, e.clientY);
  if (!pt) return false;

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
  } else if (state.tool === "crop") {
    cropSel = { from: pt, to: { ...pt } };
  }
  requestPaint();
  return true;
}

function annotationPointerMove(e) {
  if (!isDrawing) return;
  const pt = clientToSource(e.clientX, e.clientY);
  if (!pt) return;
  if (cropSel) cropSel.to = pt;
  else if (currentStroke && currentStroke.type === "draw") currentStroke.points.push(pt);
  else if (currentStroke) currentStroke.to = pt;
  requestPaint();
}

function annotationPointerUp(e) {
  if (!isDrawing) return;
  isDrawing = false;
  try { previewCanvas.releasePointerCapture(e.pointerId); } catch (_) {}

  if (cropSel) {
    const sel = cropSel;
    cropSel = null;
    applyCrop(sel);
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
  state.tool = t;
  document.querySelectorAll("[data-tool]").forEach((b) => {
    b.classList.toggle("active", b.dataset.tool === t);
  });
  const shapeBtn = document.getElementById("shapeBtn");
  shapeBtn.classList.toggle("active", SHAPE_TOOLS.has(t));
  document.getElementById("shapeDropdown").classList.remove("open");
  previewArea.classList.toggle("drawing", t !== "none");
  syncAnnotationUI();
}

// Show only the option row(s) the active tool actually uses.
function syncAnnotationUI() {
  const t = state.tool;
  document.getElementById("textSizeRow").classList.toggle("hidden", t !== "text");
  document.getElementById("redactStyleRow").classList.toggle("hidden", t !== "redact");
  document.getElementById("pixelSizeRow").classList.toggle("hidden", !(t === "redact" && state.redactStyle === "pixelate"));
  document.getElementById("colorRow").classList.toggle("hidden", t === "none" || t === "crop" || t === "cursor");
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

  document.querySelectorAll("[data-annot-color]").forEach((sw) => {
    sw.addEventListener("click", () => {
      document.querySelectorAll("[data-annot-color]").forEach((s) => s.classList.toggle("active", s === sw));
      state.color = sw.dataset.annotColor;
    });
  });

  document.querySelectorAll("[data-textsize]").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("[data-textsize]").forEach((b) => b.classList.toggle("active", b === btn));
      state.textSize = btn.dataset.textsize;
    });
  });
  document.querySelectorAll("[data-pixel]").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("[data-pixel]").forEach((b) => b.classList.toggle("active", b === btn));
      state.pixelSize = btn.dataset.pixel;
    });
  });
  document.querySelectorAll("[data-redact]").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("[data-redact]").forEach((b) => b.classList.toggle("active", b === btn));
      state.redactStyle = btn.dataset.redact;
      syncAnnotationUI();
    });
  });

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
