/* QGN Studio shell: render loop, editor mode, still export, keyboard, and
   the handoff from the main process.

   Loaded last, so every helper it wires up already exists. */

const previewArea = document.getElementById("previewArea");
const previewCanvas = document.getElementById("previewCanvas");
const previewCtx = previewCanvas.getContext("2d");
const emptyState = document.getElementById("emptyState");

/* ───────────────────────── Render loop ─────────────────────────
   One loop for both media kinds. A still repaints on demand; a playing clip
   keeps the loop alive frame by frame. */
let needsPaint = true;
let rafId = null;

function requestPaint() {
  needsPaint = true;
  ensureLoop();
}
function ensureLoop() {
  if (rafId == null) rafId = requestAnimationFrame(loopTick);
}
function loopTick() {
  rafId = null;
  // Export drives the media and its own draw loop; stay out of its way.
  if (exporting) return;
  const playing = isVideoSource() && videoReady() && !video.paused && !video.ended;
  if (playing) {
    enforceTrim();
    needsPaint = true;
  }
  if (needsPaint) {
    renderPreview();
    if (isVideoSource()) updateTransport();
    needsPaint = false;
  }
  const stillPlaying = isVideoSource() && videoReady() && !video.paused && !video.ended;
  if (stillPlaying || needsPaint) ensureLoop();
}

/* ───────────────────────── View: zoom and pan ─────────────────────────
   The preview used to be locked to fit-to-window, which on a 4K capture put
   two or three source pixels behind every screen pixel and made precise
   annotation impossible.

   Zoom is applied by growing the canvas itself rather than by transforming the
   scene inside a fixed-size canvas. That matters: every coordinate helper in
   annotate.js derives its scale from the canvas's client rect, so growing the
   element keeps hit testing, the crop rect and the selection box correct with
   no changes to any of them. Panning is a CSS translate, which the same client
   rect already accounts for. */
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 8;
const PREVIEW_PAD = 36;
// A deep zoom on a large scene could otherwise ask for a backing store big
// enough to fail allocation, so the device-pixel ratio gives way first.
const MAX_CANVAS_PIXELS = 16e6;

const view = { zoom: 1, panX: 0, panY: 0 };

function clampZoom(z) { return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z)); }

// Pan is locked to zero while the whole scene fits, and otherwise limited to
// the point where an edge of the image reaches the edge of the viewport.
function clampPan(dispW, dispH, areaRect) {
  const overX = Math.max(0, (dispW - areaRect.width) / 2);
  const overY = Math.max(0, (dispH - areaRect.height) / 2);
  view.panX = Math.max(-overX, Math.min(overX, view.panX));
  view.panY = Math.max(-overY, Math.min(overY, view.panY));
}

function resetView() {
  view.zoom = 1;
  view.panX = 0;
  view.panY = 0;
  syncZoomUI();
  requestPaint();
}

/* Zoom about a point, so whatever is under the cursor stays under it. The
   canvas is centred by its flex parent, so growing it by k moves a point at
   fraction f along the axis by (f - 0.5) * size * (k - 1); the pan cancels
   exactly that. */
function zoomAt(clientX, clientY, factor) {
  const next = clampZoom(view.zoom * factor);
  if (next === view.zoom) return;
  const rect = previewCanvas.getBoundingClientRect();
  const k = next / view.zoom;
  if (rect.width && rect.height) {
    const fx = (clientX - rect.left) / rect.width;
    const fy = (clientY - rect.top) / rect.height;
    view.panX -= (fx - 0.5) * rect.width * (k - 1);
    view.panY -= (fy - 0.5) * rect.height * (k - 1);
  }
  view.zoom = next;
  syncZoomUI();
  requestPaint();
}

// Zoom about the middle of the viewport, for the buttons and the shortcuts.
function zoomByStep(factor) {
  const r = previewArea.getBoundingClientRect();
  zoomAt(r.left + r.width / 2, r.top + r.height / 2, factor);
}

function panBy(dx, dy) {
  view.panX += dx;
  view.panY += dy;
  requestPaint();
}

function syncZoomUI() {
  const hud = document.getElementById("zoomHud");
  if (!hud) return;
  hud.classList.toggle("hidden", !hasSource());
  const label = document.getElementById("zoomLabel");
  if (label) label.textContent = Math.round(view.zoom * 100) + "%";
}

function renderPreview() {
  if (!hasSource()) return;
  const L = layout();
  const dpr = window.devicePixelRatio || 1;
  const areaRect = previewArea.getBoundingClientRect();
  const availW = Math.max(50, areaRect.width - PREVIEW_PAD * 2);
  const availH = Math.max(50, areaRect.height - PREVIEW_PAD * 2);
  const fit = Math.min(availW / L.sceneW, availH / L.sceneH) * view.zoom;
  const dispW = L.sceneW * fit;
  const dispH = L.sceneH * fit;

  clampPan(dispW, dispH, areaRect);
  previewCanvas.style.width = dispW + "px";
  previewCanvas.style.height = dispH + "px";
  previewCanvas.style.transform =
    view.panX || view.panY ? `translate(${view.panX}px, ${view.panY}px)` : "";

  // Trade device pixels away rather than fail to allocate at deep zoom.
  const wanted = dispW * dispH * dpr * dpr;
  const px = wanted > MAX_CANVAS_PIXELS ? dpr * Math.sqrt(MAX_CANVAS_PIXELS / wanted) : dpr;
  previewCanvas.width = Math.max(1, Math.round(dispW * px));
  previewCanvas.height = Math.max(1, Math.round(dispH * px));
  renderSceneScaled(previewCtx, fit * px, fit * px, L);
  // The crop rect and the selection box are editor chrome, not part of the
  // composition: painting them here, on top of the finished scene, keeps them
  // out of every export path.
  drawCropOverlay(previewCtx, L);
  drawSelectionOverlay(previewCtx, L);
}

// Toggle the import prompt against the live canvas.
function updateEmptyState() {
  const has = hasSource();
  emptyState.classList.toggle("hidden", has || isVideoSource());
  previewCanvas.classList.toggle("hidden", !has);
  syncZoomUI();
}

/* ───────────────────────── Toast ───────────────────────── */
let toastTimer = null;
function showStudioToast(msg, isError) {
  const toastEl = document.getElementById("toast");
  toastEl.textContent = msg;
  toastEl.classList.toggle("error", !!isError);
  toastEl.classList.add("show");
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("show"), 2200);
}

/* ───────────────────────── Editor mode ─────────────────────────
   Markup is the old annotation editor: bare pixels, saved back over the
   source. Compose is the old studio: framed on a background, saved as a new
   image. Same window, one scene engine, two sets of defaults. */
const COMPOSE_DEFAULTS = { frame: "window", padPct: 0.08, radiusPct: 0.018, shadowPct: 0.05, aspect: "auto" };
const MARKUP_DEFAULTS = { frame: "none", padPct: 0, radiusPct: 0, shadowPct: 0, aspect: "auto" };
let composeMemory = null;

function applyModeChrome() {
  const markup = editorMode === "markup";
  document.querySelectorAll("#modeTabs .seg").forEach((b) => b.classList.toggle("active", b.dataset.mode === editorMode));
  document.querySelector(".sidebar").classList.toggle("hidden", markup);
  const saveBtn = document.getElementById("saveBtn");
  saveBtn.textContent = markup ? "Save" : "Save as new";
  saveBtn.title = markup
    ? "Write the edited image back over the original"
    : "Save the composed image as a new capture";
}

function applyInitialMode(mode) {
  editorMode = mode === "markup" ? "markup" : "compose";
  Object.assign(state, editorMode === "markup" ? MARKUP_DEFAULTS : COMPOSE_DEFAULTS);
  if (editorMode === "markup") state.tool = "draw";
  applyModeChrome();
  syncSidebarToState();
  selectTool(state.tool);
}

function setEditorMode(mode) {
  if (mode === editorMode) return;
  // Coming out of compose, remember the framing so a round trip does not
  // silently discard it.
  if (editorMode === "compose") {
    composeMemory = {
      frame: state.frame, padPct: state.padPct, radiusPct: state.radiusPct,
      shadowPct: state.shadowPct, aspect: state.aspect,
    };
  }
  editorMode = mode;
  Object.assign(state, mode === "markup" ? MARKUP_DEFAULTS : (composeMemory || COMPOSE_DEFAULTS));
  window.studio.setAlwaysOnTop(mode === "markup");
  applyModeChrome();
  syncSidebarToState();
  markDirty();
  requestPaint();
}

/* ───────────────────────── Still export ───────────────────────── */
function composeImage() {
  const L = layout();
  const out = document.createElement("canvas");
  out.width = Math.max(1, Math.round(L.sceneW));
  out.height = Math.max(1, Math.round(L.sceneH));
  renderSceneScaled(out.getContext("2d"), 1, 1, L);
  return out;
}

function exportImageTo(send, after) {
  if (!hasSource()) return;
  composeImage().toBlob((blob) => {
    if (!blob) { showStudioToast("Couldn't render the image.", true); return; }
    blob.arrayBuffer().then((buf) => {
      send(new Uint8Array(buf));
      if (after) after();
    });
  }, "image/png");
}

let copyFlashTimer = null;
function flashCopied() {
  const copyBtn = document.getElementById("copyBtn");
  copyBtn.classList.add("flash");
  if (copyFlashTimer) clearTimeout(copyFlashTimer);
  copyFlashTimer = setTimeout(() => copyBtn.classList.remove("flash"), 1200);
  showStudioToast("Copied to clipboard");
}

function doCopy() { exportImageTo(window.studio.copy, flashCopied); }
function doSave() {
  exportImageTo(editorMode === "markup" ? window.studio.overwrite : window.studio.save);
}

/* ───────────────────────── Still source ───────────────────────── */
function loadImageSource(dataUrl) {
  if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/")) return;
  const img = new Image();
  img.onerror = () => {
    console.error("Failed to load studio image");
    showStudioToast("Couldn't load that image. Try a different file.", true);
  };
  img.onload = () => {
    source.kind = "image";
    source.el = img;
    source.naturalW = img.naturalWidth;
    source.naturalH = img.naturalHeight;
    source.loaded = true;
    state.crop = null;
    state.strokes = [];
    state.calloutCounter = 1;
    state.selectedStrokeId = null;
    // Drop anything left over from a clip, or the still would render through a
    // stale camera with a synthetic cursor on top of it.
    resetVideoState();
    resetHistory();
    // A new image starts fit to the window, not at the last one's zoom.
    resetView();
    syncAnnotationUI();
    applyVideoChrome();
    updateEmptyState();
    requestPaint();
  };
  img.src = dataUrl;
}

function importImageFile(file) {
  if (!file || !file.type || !file.type.startsWith("image/")) return;
  markDirty(); // a manual import is a change worth guarding on close
  const reader = new FileReader();
  reader.onload = () => loadImageSource(reader.result);
  reader.readAsDataURL(file);
}

/* ───────────────────────── Close ───────────────────────── */
function requestClose() {
  if (dirty && !exporting && !window.confirm("Discard your changes and close Studio?")) return;
  window.studio.cancel();
}

/* ───────────────────────── Help ───────────────────────── */
function toggleHelp(force) {
  const helpOverlay = document.getElementById("helpOverlay");
  const show = force === undefined ? !helpOverlay.classList.contains("show") : force;
  helpOverlay.classList.toggle("show", show);
}

/* ───────────────────────── Boot ───────────────────────── */
function init() {
  initAnnotationUI();
  initSidebar();
  initVideoUI();
  applyVideoChrome();
  applyModeChrome();
  updateEmptyState();

  /* Preview pointer input: focus picking wins, then annotation tools. */
  previewCanvas.addEventListener("pointerdown", (e) => {
    if (exporting) return;
    if (handleFocusPick(e)) return;
    annotationPointerDown(e);
  });
  previewCanvas.addEventListener("pointermove", (e) => { if (!exporting) annotationPointerMove(e); });
  previewCanvas.addEventListener("pointerup", annotationPointerUp);
  previewCanvas.addEventListener("pointercancel", annotationPointerUp);

  /* Zoom and pan. Ctrl/Cmd + wheel zooms about the cursor; a plain wheel pans,
     which only does anything once the image is bigger than the viewport. */
  previewArea.addEventListener("wheel", (e) => {
    if (exporting || !hasSource()) return;
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.002));
      return;
    }
    if (e.shiftKey) panBy(-e.deltaY - e.deltaX, 0);
    else panBy(-e.deltaX, -e.deltaY);
  }, { passive: false });

  // Middle-drag pans, the way it does in every other canvas editor. It is on
  // the area rather than the canvas so the grab still works in the surround.
  let panDrag = null;
  previewArea.addEventListener("pointerdown", (e) => {
    if (e.button !== 1 || exporting || !hasSource()) return;
    e.preventDefault();
    panDrag = { x: e.clientX, y: e.clientY };
    previewArea.style.cursor = "grabbing";
    try { previewArea.setPointerCapture(e.pointerId); } catch (_) {}
  });
  previewArea.addEventListener("pointermove", (e) => {
    if (!panDrag) return;
    panBy(e.clientX - panDrag.x, e.clientY - panDrag.y);
    panDrag = { x: e.clientX, y: e.clientY };
  });
  const endPan = (e) => {
    if (!panDrag) return;
    panDrag = null;
    previewArea.style.cursor = "";
    try { previewArea.releasePointerCapture(e.pointerId); } catch (_) {}
  };
  previewArea.addEventListener("pointerup", endPan);
  previewArea.addEventListener("pointercancel", endPan);

  document.getElementById("zoomInBtn").addEventListener("click", () => zoomByStep(1.25));
  document.getElementById("zoomOutBtn").addEventListener("click", () => zoomByStep(1 / 1.25));
  document.getElementById("zoomResetBtn").addEventListener("click", resetView);

  /* Top bar. */
  document.getElementById("cancelBtn").addEventListener("click", requestClose);
  document.getElementById("copyBtn").addEventListener("click", doCopy);
  document.getElementById("saveBtn").addEventListener("click", doSave);
  document.getElementById("helpBtn").addEventListener("click", () => toggleHelp());
  document.getElementById("helpOverlay").addEventListener("click", (e) => {
    if (e.target.id === "helpOverlay") toggleHelp(false);
  });
  document.querySelectorAll("#modeTabs .seg").forEach((b) => {
    b.addEventListener("click", () => setEditorMode(b.dataset.mode));
  });

  /* Import: button, empty state, drag and drop, paste. */
  const importInput = document.getElementById("importInput");
  document.getElementById("importBtn").addEventListener("click", () => importInput.click());
  emptyState.addEventListener("click", () => importInput.click());
  importInput.addEventListener("change", () => {
    importImageFile(importInput.files && importInput.files[0]);
    importInput.value = "";
  });

  // Prevent the window from navigating to a file dropped outside the zone.
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => e.preventDefault());
  previewArea.addEventListener("dragover", (e) => {
    e.preventDefault();
    if (!isVideoSource()) previewArea.classList.add("dragover");
  });
  previewArea.addEventListener("dragleave", (e) => {
    if (e.target === previewArea) previewArea.classList.remove("dragover");
  });
  previewArea.addEventListener("drop", (e) => {
    e.preventDefault();
    previewArea.classList.remove("dragover");
    if (isVideoSource()) return;
    importImageFile(e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]);
  });
  document.addEventListener("paste", (e) => {
    if (isVideoSource()) return;
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (const it of items) {
      if (it.type && it.type.startsWith("image/")) {
        const file = it.getAsFile();
        if (file) { e.preventDefault(); importImageFile(file); return; }
      }
    }
  });

  /* Any sidebar or tool-rail edit flags the session dirty. */
  for (const sel of [".sidebar", ".toolrail"]) {
    const el = document.querySelector(sel);
    el.addEventListener("input", markDirty, true);
    el.addEventListener("click", (e) => {
      if (e.target.closest(".seg, .swatch, .pal, .btn, .upload-btn, .tool-btn, .size-btn")) markDirty();
    }, true);
  }

  window.addEventListener("resize", requestPaint);

  document.addEventListener("keydown", onKeyDown);

  /* Seed from the main process. Studio can also open empty and import later. */
  window.studio.onLoad((data) => {
    if (!data) return;
    applyInitialMode(data.mode);
    if (data.kind === "video") loadVideoSource(data);
    else if (data.imageDataUrl) loadImageSource(data.imageDataUrl);
    else { applyVideoChrome(); updateEmptyState(); }
  });
}

/* ───────────────────────── Keyboard ───────────────────────── */
function onKeyDown(e) {
  if (e.target && e.target.tagName === "INPUT") {
    if (e.key === "Escape") e.target.blur();
    return;
  }
  const helpOverlay = document.getElementById("helpOverlay");
  if (helpOverlay.classList.contains("show")) {
    if (e.key === "Escape") toggleHelp(false);
    return;
  }
  if (exporting) {
    // Escape aborts a running render, or dismisses the panel once it has
    // failed and is only there to show the message.
    if (e.key === "Escape") { if (exportErrored) hideProgress(); else exportAbort = true; }
    return;
  }
  if (e.key === "?" || (e.shiftKey && e.key === "/")) { toggleHelp(); return; }

  if (e.key === "Escape") {
    if (pickingFocus) { setPickingFocus(false); return; }
    if (state.selectedStrokeId != null) { selectStroke(null); return; }
    if (state.selectedSegId) { selectSeg(null); return; }
    // In crop mode Escape backs out one step at a time: first the pending
    // rect, then the tool.
    if (state.tool === "crop" && cancelCropSel()) return;
    if (state.tool !== "none") { selectTool("none"); return; }
    requestClose();
    return;
  }

  if (e.key === "Enter" && state.tool === "crop") { e.preventDefault(); commitCropSel(); return; }

  const mod = e.ctrlKey || e.metaKey;
  if (mod) {
    if (e.key === "y" || e.key === "Y" || ((e.key === "z" || e.key === "Z") && e.shiftKey)) {
      e.preventDefault(); redo(); return;
    }
    if (e.key === "z" || e.key === "Z") { e.preventDefault(); undo(); return; }
    if (e.key === "s" || e.key === "S") { e.preventDefault(); if (!isVideoSource()) doSave(); return; }
    if (e.key === "c" || e.key === "C") { e.preventDefault(); if (!isVideoSource()) doCopy(); return; }
    if (e.key === "e" || e.key === "E") { e.preventDefault(); if (isVideoSource()) startExport(); return; }
    // Zoom, on the keys every editor uses for it.
    if (e.key === "0") { e.preventDefault(); resetView(); return; }
    if (e.key === "=" || e.key === "+") { e.preventDefault(); zoomByStep(1.25); return; }
    if (e.key === "-" || e.key === "_") { e.preventDefault(); zoomByStep(1 / 1.25); return; }
    return;
  }

  // A selected annotation owns Delete before a selected zoom segment does:
  // the pointer tool is what put it there.
  if ((e.key === "Delete" || e.key === "Backspace") && state.selectedStrokeId != null) {
    e.preventDefault();
    deleteSelectedStroke();
    return;
  }

  // Clip transport.
  if (isVideoSource()) {
    if ((e.key === "Delete" || e.key === "Backspace") && state.selectedSegId) {
      e.preventDefault(); document.getElementById("delZoomBtn").click(); return;
    }
    if (e.key === " ") { e.preventDefault(); togglePlay(); return; }
    if (e.key === "i" || e.key === "I") {
      state.trimIn = Math.max(0, Math.min(video.currentTime, state.trimOut - 0.1));
      markDirty(); updateTransport(); return;
    }
    if (e.key === "o" || e.key === "O") {
      state.trimOut = Math.min(duration, Math.max(video.currentTime, state.trimIn + 0.1));
      markDirty(); updateTransport(); return;
    }
    if (e.key === "ArrowLeft") { seekPreview(video.currentTime - (e.shiftKey ? 1 : 1 / 30)); return; }
    if (e.key === "ArrowRight") { seekPreview(video.currentTime + (e.shiftKey ? 1 : 1 / 30)); return; }
  }

  // Annotation tools.
  const TOOL_KEYS = {
    v: "none", d: "draw", a: "arrow", t: "text",
    x: "redact", c: "callout", p: "cursor", r: "crop",
  };
  const k = e.key.toLowerCase();
  if (k === "s") { selectTool(state.shapeType); return; }
  if (TOOL_KEYS[k]) selectTool(TOOL_KEYS[k]);
}

init();
