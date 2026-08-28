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

function renderPreview() {
  if (!hasSource()) return;
  const L = layout();
  const dpr = window.devicePixelRatio || 1;
  const areaRect = previewArea.getBoundingClientRect();
  const pad = 36;
  const availW = Math.max(50, areaRect.width - pad * 2);
  const availH = Math.max(50, areaRect.height - pad * 2);
  const fit = Math.min(availW / L.sceneW, availH / L.sceneH);
  const dispW = L.sceneW * fit;
  const dispH = L.sceneH * fit;
  previewCanvas.style.width = dispW + "px";
  previewCanvas.style.height = dispH + "px";
  previewCanvas.width = Math.max(1, Math.round(dispW * dpr));
  previewCanvas.height = Math.max(1, Math.round(dispH * dpr));
  renderSceneScaled(previewCtx, fit * dpr, fit * dpr, L);
}

// Toggle the import prompt against the live canvas.
function updateEmptyState() {
  const has = hasSource();
  emptyState.classList.toggle("hidden", has || isVideoSource());
  previewCanvas.classList.toggle("hidden", !has);
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
    // Drop anything left over from a clip, or the still would render through a
    // stale camera with a synthetic cursor on top of it.
    resetVideoState();
    resetHistory();
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
    if (state.selectedSegId) { selectSeg(null); return; }
    if (state.tool !== "none") { selectTool("none"); return; }
    requestClose();
    return;
  }

  const mod = e.ctrlKey || e.metaKey;
  if (mod) {
    if (e.key === "y" || e.key === "Y" || ((e.key === "z" || e.key === "Z") && e.shiftKey)) {
      e.preventDefault(); redo(); return;
    }
    if (e.key === "z" || e.key === "Z") { e.preventDefault(); undo(); return; }
    if (e.key === "s" || e.key === "S") { e.preventDefault(); if (!isVideoSource()) doSave(); return; }
    if (e.key === "c" || e.key === "C") { e.preventDefault(); if (!isVideoSource()) doCopy(); return; }
    if (e.key === "e" || e.key === "E") { e.preventDefault(); if (isVideoSource()) startExport(); return; }
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
