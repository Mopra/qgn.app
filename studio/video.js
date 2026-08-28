/* QGN Studio: everything that only applies when the source is a clip:
   playback, trim, the zoom keyframe lane, the audio graph and the video
   exporters.

   The scene itself (background, frame, layout, annotations) is not in here.
   That is the point of the split: a clip is just a source that happens to
   change with time. */

const video = document.getElementById("srcVideo");
let duration = 0;
let exporting = false;
let blobUrl = null;
let exportAbort = false;
let exportErrored = false;
let pickingFocus = false;

function videoReady() { return source.kind === "video" && source.loaded; }
function isVideoSource() { return source.kind === "video"; }

/* ───────────────────────── Transport ───────────────────────── */
const PLAY_ICON = '<polygon points="7,4 20,12 7,20"/>';
const PAUSE_ICON = '<rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/>';

function fmtTime(t) {
  if (!isFinite(t)) t = 0;
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return m + ":" + String(s).padStart(2, "0");
}

function pct(t) { return duration > 0 ? (t / duration) * 100 : 0; }

function updateTransport() {
  if (!isVideoSource()) return;
  const cur = videoReady() ? video.currentTime : 0;
  document.getElementById("playhead").style.left = pct(cur) + "%";
  document.getElementById("mPlayhead").style.left = pct(cur) + "%";
  const trackSel = document.getElementById("trackSel");
  trackSel.style.left = pct(state.trimIn) + "%";
  trackSel.style.width = Math.max(0, pct(state.trimOut) - pct(state.trimIn)) + "%";
  document.getElementById("handleIn").style.left = pct(state.trimIn) + "%";
  document.getElementById("handleOut").style.left = pct(state.trimOut) + "%";
  document.getElementById("timeLabel").innerHTML = "<b>" + fmtTime(cur) + "</b> / " + fmtTime(duration);
  document.getElementById("playIcon").innerHTML =
    (videoReady() && !video.paused && !video.ended) ? PAUSE_ICON : PLAY_ICON;
  updateSizeHint();
}

// Keep playback inside [trimIn, trimOut]; loop or pause at the out point.
function enforceTrim() {
  if (!videoReady()) return;
  if (video.currentTime < state.trimIn - 0.05) video.currentTime = state.trimIn;
  if (video.currentTime >= state.trimOut - 0.001) {
    if (state.loop) {
      video.currentTime = state.trimIn;
    } else {
      video.pause();
      video.currentTime = state.trimOut;
      requestPaint();
    }
  }
}

function togglePlay() {
  if (!videoReady() || exporting) return;
  if (video.paused || video.ended) {
    if (video.currentTime >= state.trimOut - 0.001) video.currentTime = state.trimIn;
    ensureAudioGraph();
    video.play().catch(() => {});
  } else {
    video.pause();
  }
  requestPaint();
}

// Seek to a time, repaint once when paused.
function seekPreview(t) {
  if (!videoReady()) return;
  video.currentTime = Math.max(0, Math.min(duration, t));
  requestPaint();
}

/* ───────────────────────── Audio graph ─────────────────────────
   Built lazily on first play (needs a user gesture). source -> gainMute ->
   { monitorGain -> speakers, audioDest -> export tap }. */
let audioCtx = null, gainMute = null, monitorGain = null, audioDest = null, audioGraphFailed = false;

function ensureAudioGraph() {
  if (audioCtx || audioGraphFailed) {
    if (audioCtx && audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
    return;
  }
  try {
    audioCtx = new AudioContext();
    const srcNode = audioCtx.createMediaElementSource(video);
    gainMute = audioCtx.createGain();
    monitorGain = audioCtx.createGain();
    audioDest = audioCtx.createMediaStreamDestination();
    srcNode.connect(gainMute);
    gainMute.connect(monitorGain);
    monitorGain.connect(audioCtx.destination);
    gainMute.connect(audioDest);
    gainMute.gain.value = state.muted ? 0 : 1;
    monitorGain.gain.value = 1;
  } catch (e) {
    audioGraphFailed = true;
    video.muted = state.muted; // best-effort fallback
  }
}
function applyMute() {
  if (gainMute) gainMute.gain.value = state.muted ? 0 : 1;
  else video.muted = state.muted;
}
function refreshMuteBtn() {
  const muteBtn = document.getElementById("muteBtn");
  muteBtn.classList.toggle("muted", state.muted);
  muteBtn.title = state.muted ? "Audio muted in export, click to keep audio" : "Mute audio in the export";
}

/* ───────────────────────── Zoom keyframe lane ───────────────────────── */
function sortSegments() { state.zoomSegments.sort((a, b) => a.startT - b.startT); }
function selectedSeg() { return state.zoomSegments.find((s) => s.id === state.selectedSegId) || null; }
function markMotionDirty() { markDirty(); requestPaint(); }

function renderMotionLane() {
  const motionLane = document.getElementById("motionLane");
  const motionEmpty = document.getElementById("motionEmpty");
  motionLane.querySelectorAll(".zseg").forEach((el) => el.remove());
  const has = state.zoomSegments.length > 0;
  motionEmpty.style.display = has ? "none" : "flex";
  if (!has) {
    motionEmpty.textContent = state.motion
      ? "No zoom keyframes, add one or hit Auto"
      : "No motion data for this clip";
  }
  for (const seg of state.zoomSegments) {
    const el = document.createElement("div");
    el.className = "zseg" + (seg.source === "auto" ? " auto" : "") + (seg.id === state.selectedSegId ? " selected" : "");
    el.style.left = pct(seg.startT) + "%";
    el.style.width = Math.max(0.5, pct(seg.endT) - pct(seg.startT)) + "%";
    el.dataset.id = seg.id;
    el.textContent = seg.scale.toFixed(1) + "×";
    const le = document.createElement("div"); le.className = "zedge l"; le.dataset.edge = "l";
    const re = document.createElement("div"); re.className = "zedge r"; re.dataset.edge = "r";
    el.appendChild(le); el.appendChild(re);
    motionLane.appendChild(el);
  }
}

// Keep the inspector and toolbar in sync with selection / motion presence.
function syncMotionUI() {
  if (!isVideoSource()) return;
  renderMotionLane();
  const seg = selectedSeg();
  document.getElementById("delZoomBtn").disabled = !seg;
  document.getElementById("regenZoomBtn").disabled = !state.motion;
  document.getElementById("zoomSection").classList.toggle("hidden", !seg);
  if (seg) {
    const zoomScale = document.getElementById("zoomScale");
    const zoomEaseIn = document.getElementById("zoomEaseIn");
    const zoomEaseOut = document.getElementById("zoomEaseOut");
    zoomScale.value = Math.round(seg.scale * 100);
    document.getElementById("zoomScaleValue").textContent = seg.scale.toFixed(1) + "×";
    zoomEaseIn.value = Math.round(seg.easeIn * 100);
    document.getElementById("zoomEaseInValue").textContent = seg.easeIn.toFixed(1) + "s";
    zoomEaseOut.value = Math.round(seg.easeOut * 100);
    document.getElementById("zoomEaseOutValue").textContent = seg.easeOut.toFixed(1) + "s";
  }
  const hint = document.getElementById("cursorHint");
  if (hint) {
    hint.textContent = !state.motion
      ? "No motion data. Cursor effects need a recorded clip."
      : "The real cursor is already in the video. Enable the synthetic cursor only if you want a styled overlay on top.";
  }
}

function selectSeg(id) {
  state.selectedSegId = id;
  if (pickingFocus && !id) setPickingFocus(false);
  syncMotionUI();
}

function setPickingFocus(on) {
  pickingFocus = on;
  const btn = document.getElementById("setFocusBtn");
  btn.classList.toggle("active", on);
  previewArea.classList.toggle("picking-focus", on);
  btn.textContent = on ? "Click preview to set focus…" : "Set focus point";
}

/* ───────────────────────── Export sizing ─────────────────────────
   One plan function for gif/webp, used by both the size estimate and the
   exporter so the number the user sees is the render they get. Frame count is
   capped first, then the resolution is scaled down until the raw strip the main
   process has to assemble fits in its memory budget. Long clips therefore come
   out smaller rather than failing. */
function animPlan(format) {
  const L = layout();
  const span = Math.max(0.05, state.trimOut - state.trimIn);
  // Sample at most ANIM_MAX_FRAMES frames spread evenly across the trim. A long
  // clip therefore comes out as a sparser animation instead of overflowing the
  // frame cap and failing outright.
  const total = Math.max(1, Math.min(ANIM_MAX_FRAMES, Math.round(span * ANIM_FPS)));
  const fps = total / span;
  let maxLong = format === "gif" ? GIF_MAX_LONG : WEBP_MAX_LONG;
  const longSide = Math.max(L.sceneW, L.sceneH) || 1;
  const dims = (ml) => {
    const scale = Math.min(1, ml / longSide);
    return { w: Math.max(2, Math.round(L.sceneW * scale)), h: Math.max(2, Math.round(L.sceneH * scale)) };
  };
  let { w, h } = dims(maxLong);
  const needed = w * h * 4 * total;
  if (needed > ANIM_RAW_BUDGET) {
    maxLong = Math.max(ANIM_MIN_LONG, Math.floor(maxLong * Math.sqrt(ANIM_RAW_BUDGET / needed)));
    ({ w, h } = dims(maxLong));
  }
  // Delay follows the real sampling interval so a sparse animation still plays
  // back over the same wall-clock length as the clip it came from.
  return { fps, total, span, maxLong, w, h, delay: Math.max(20, Math.round((span / total) * 1000)), L };
}

function fmtBytes(n) {
  if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(n >= 10 * 1024 * 1024 ? 0 : 1) + " MB";
  return Math.max(1, Math.round(n / 1024)) + " KB";
}

// Rough output-size estimate so the user can pick a format before a slow
// render. Heuristic only, labelled with "~".
function estimateExportBytes() {
  const span = Math.max(0.05, state.trimOut - state.trimIn);
  const L = layout();
  const longSide = Math.max(L.sceneW, L.sceneH) || 1;
  const f = state.format;
  if (f === "gif" || f === "webp") {
    const plan = animPlan(f);
    const perFrame = f === "gif" ? plan.w * plan.h * 0.5 : plan.w * plan.h * 0.12;
    return perFrame * plan.total;
  }
  const scale = Math.min(1, ENCODED_MAX_LONG / longSide);
  const w = Math.max(2, Math.round(L.sceneW * scale));
  const h = Math.max(2, Math.round(L.sceneH * scale));
  const bps = Math.min(50000000, Math.max(8000000, Math.round(w * h * 30 * 0.15)));
  return (bps * span) / 8;
}

function updateSizeHint() {
  const el = document.getElementById("sizeHint");
  if (el) el.textContent = videoReady() ? "Estimated size: ~" + fmtBytes(estimateExportBytes()) : "";
}

function setFormat(f) {
  state.format = f;
  document.querySelectorAll("#formatTabs .seg").forEach((s) => s.classList.toggle("active", s.dataset.format === f));
  document.getElementById("formatHint").textContent = FORMAT_HINTS[f] || "";
  document.getElementById("exportBtn").textContent = "Export " + f.toUpperCase();
  updateSizeHint();
}

/* ───────────────────────── Export progress ───────────────────────── */
function showProgress(title) {
  exporting = true;
  exportAbort = false;
  exportErrored = false;
  const fill = document.getElementById("progressFill");
  document.getElementById("progressTitle").textContent = title;
  fill.style.width = "0%";
  document.getElementById("progressSub").textContent = "0%";
  fill.parentElement.style.visibility = "visible";
  document.getElementById("cancelExportBtn").textContent = "Cancel";
  document.getElementById("progressOverlay").classList.add("active");
  document.getElementById("exportBtn").disabled = true;
  // Settings feed the live scene; lock them so a stray click cannot alter
  // frames mid-render.
  document.querySelector(".sidebar").style.pointerEvents = "none";
  document.querySelector(".toolrail").style.pointerEvents = "none";
}
function setProgress(frac) {
  const p = Math.max(0, Math.min(100, Math.round(frac * 100)));
  document.getElementById("progressFill").style.width = p + "%";
  document.getElementById("progressSub").textContent = p + "%";
}
function hideProgress() {
  exporting = false;
  exportErrored = false;
  document.getElementById("progressOverlay").classList.remove("active");
  document.getElementById("exportBtn").disabled = false;
  document.querySelector(".sidebar").style.pointerEvents = "";
  document.querySelector(".toolrail").style.pointerEvents = "";
  requestPaint();
}
// Keep the overlay up showing an error until the user dismisses it.
function showExportError(msg) {
  // Treat the error panel as part of the export: it owns Escape and blocks the
  // render loop until dismissed, whether or not showProgress ever ran.
  exporting = true;
  exportErrored = true;
  const fill = document.getElementById("progressFill");
  document.getElementById("progressTitle").textContent = msg || "Export failed.";
  fill.parentElement.style.visibility = "hidden";
  document.getElementById("progressSub").textContent = "";
  document.getElementById("cancelExportBtn").textContent = "Close";
  document.getElementById("progressOverlay").classList.add("active");
  document.getElementById("exportBtn").disabled = false;
}

/* ───────────────────────── Export helpers ───────────────────────── */
// Even-dimension export canvas scaled to fit maxLong, drawn at 1:1 scene.
function makeExportCanvas(maxLong, forceEven) {
  const L = layout();
  const longSide = Math.max(L.sceneW, L.sceneH);
  const scale = Math.min(1, maxLong / longSide);
  let w = Math.max(2, Math.round(L.sceneW * scale));
  let h = Math.max(2, Math.round(L.sceneH * scale));
  if (forceEven) { w -= w % 2; h -= h % 2; }
  const cvs = document.createElement("canvas");
  cvs.width = w; cvs.height = h;
  const ctx = cvs.getContext("2d", { alpha: false });
  return { cvs, ctx, w, h, L };
}

// Composited thumbnail (PNG data URL) for the preview card.
function captureThumbnail() {
  const { cvs, ctx, w, h, L } = makeExportCanvas(600, false);
  renderSceneScaled(ctx, w / L.sceneW, h / L.sceneH, L);
  try { return cvs.toDataURL("image/png"); } catch (e) { return null; }
}

function awaitSeek(t) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (done) return; done = true; video.removeEventListener("seeked", finish); resolve(); };
    video.addEventListener("seeked", finish);
    video.currentTime = t;
    // Safety: some seeks within the same frame do not fire 'seeked'.
    setTimeout(finish, 400);
  });
}
function blobToBytes(blob) {
  return blob.arrayBuffer().then((buf) => new Uint8Array(buf));
}
function canvasToPngBytes(cvs) {
  return new Promise((resolve, reject) => {
    cvs.toBlob((b) => { if (b) blobToBytes(b).then(resolve); else reject(new Error("toBlob failed")); }, "image/png");
  });
}

/* ── Real-time encoded export (mp4 / webm) ── */
function pickMime(format, hasAudio) {
  if (format === "webm") return hasAudio ? "video/webm;codecs=vp9,opus" : "video/webm;codecs=vp9";
  const t = hasAudio ? "video/mp4;codecs=avc1,mp4a.40.2" : "video/mp4;codecs=avc1";
  if (MediaRecorder.isTypeSupported(t)) return t;
  return hasAudio ? "video/webm;codecs=vp9,opus" : "video/webm;codecs=vp9";
}

function exportEncoded(format) {
  const { cvs, ctx, w, h, L } = makeExportCanvas(ENCODED_MAX_LONG, true);
  const sx = w / L.sceneW, sy = h / L.sceneH;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, w, h);

  const recStream = new MediaStream();
  const canvasStream = cvs.captureStream(30);
  canvasStream.getVideoTracks().forEach((t) => recStream.addTrack(t));

  let usedAudio = false;
  if (!state.muted) {
    ensureAudioGraph();
    if (audioDest) {
      const tracks = audioDest.stream.getAudioTracks();
      if (tracks.length) { recStream.addTrack(tracks[0]); usedAudio = true; }
    }
  }

  const mimeType = pickMime(format, usedAudio);
  const videoBitsPerSecond = Math.min(50000000, Math.max(8000000, Math.round(w * h * 30 * 0.15)));
  let recorder;
  try {
    recorder = new MediaRecorder(recStream, { mimeType, videoBitsPerSecond });
  } catch (e) {
    console.error("MediaRecorder init failed:", e);
    showExportError("This video format isn't supported on this system. Try WebM.");
    return;
  }

  const chunks = [];
  recorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };

  let drawId = null;
  const ext = mimeType.indexOf("video/mp4") === 0 ? "mp4" : "webm";

  function drawExportFrame() {
    renderSceneScaled(ctx, sx, sy, L);
    const span = Math.max(0.001, state.trimOut - state.trimIn);
    setProgress((video.currentTime - state.trimIn) / span);
    drawId = requestAnimationFrame(drawExportFrame);
  }

  function stopAll() {
    if (drawId != null) cancelAnimationFrame(drawId);
    drawId = null;
    video.pause();
    if (monitorGain) monitorGain.gain.value = 1;
    video.onended = null;
    video.ontimeupdate = null;
  }

  let watch = null;
  let stalled = false;
  function clearWatch() { if (watch != null) { clearInterval(watch); watch = null; } }

  recorder.onstop = () => {
    stopAll();
    clearWatch();
    if (exportAbort) { hideProgress(); return; }
    if (stalled) { showExportError("Playback stalled, so nothing was recorded. Try again."); return; }
    const thumb = captureThumbnail();
    const blob = new Blob(chunks, { type: mimeType });
    blobToBytes(blob).then((bytes) => {
      // An empty recording would be written out as a zero-byte file and show up
      // as a broken capture card, so surface it as the failure it is.
      if (!bytes || bytes.length === 0) {
        showExportError("The render produced no video. Try WebM, or a shorter trim.");
        return;
      }
      window.studio.exportEncoded(bytes, thumb, ext);
    });
  };

  const onProgressCheck = () => {
    if (exportAbort) { if (recorder.state !== "inactive") recorder.stop(); return; }
    if (video.currentTime >= state.trimOut - 0.001) {
      if (recorder.state !== "inactive") recorder.stop();
    }
  };

  // Render from trimIn to trimOut once, no looping, with audio monitored
  // silently so the export plays out in real time.
  showProgress("Rendering " + ext.toUpperCase() + "…");
  ensureAudioGraph();
  if (monitorGain) monitorGain.gain.value = 0;
  awaitSeek(state.trimIn).then(() => {
    // Cancelling during the seek must not kick off a full real-time render.
    if (exportAbort) { stopAll(); hideProgress(); return; }
    recorder.start(100);
    drawExportFrame();
    video.ontimeupdate = onProgressCheck;
    video.onended = () => { if (recorder.state !== "inactive") recorder.stop(); };
    video.play().catch(() => {});
    // Watchdog: covers timeupdate going quiet near the end, and playback that
    // never starts at all (which would otherwise hang on 0% forever).
    let lastT = video.currentTime;
    let stillTicks = 0;
    watch = setInterval(() => {
      if (!exporting || recorder.state === "inactive") { clearWatch(); return; }
      if (Math.abs(video.currentTime - lastT) < 1e-4) stillTicks++;
      else { stillTicks = 0; lastT = video.currentTime; }
      if (stillTicks >= EXPORT_STALL_TICKS) {
        stalled = true;
        clearWatch();
        if (recorder.state !== "inactive") recorder.stop();
        return;
      }
      onProgressCheck();
    }, EXPORT_WATCH_MS);
  });
}

/* ── Frame-stepped animated export (gif / webp) ── */
function exportAnimated(format) {
  const plan = animPlan(format);
  const { total, delay, span } = plan;
  const { cvs, ctx, w, h, L } = makeExportCanvas(plan.maxLong, false);
  const sx = w / L.sceneW, sy = h / L.sceneH;

  showProgress("Rendering " + format.toUpperCase() + "…");
  video.pause();

  const frames = [];
  let i = 0;
  function step() {
    if (exportAbort) { hideProgress(); return; }
    if (i >= total) {
      const thumb = captureThumbnail();
      window.studio.exportFrames({
        frames, delays: frames.map(() => delay),
        width: w, height: h, format, thumbnailDataUrl: thumb,
      });
      return;
    }
    const t = Math.min(state.trimOut - 0.001, state.trimIn + (i / total) * span);
    awaitSeek(t).then(() => {
      renderSceneScaled(ctx, sx, sy, L);
      return canvasToPngBytes(cvs);
    }).then((bytes) => {
      frames.push(bytes);
      i++;
      setProgress(i / total);
      // Yield to the event loop so the progress bar can paint.
      setTimeout(step, 0);
    }).catch(() => { i++; setTimeout(step, 0); });
  }
  step();
}

function startExport() {
  if (!videoReady() || exporting) return;
  video.pause();
  requestPaint();
  if (state.format === "gif" || state.format === "webp") exportAnimated(state.format);
  else exportEncoded(state.format);
}

/* ───────────────────────── Load ─────────────────────────
   MediaRecorder-produced WebM can report Infinity duration until fully
   scanned; force a finite duration before initializing the trim range. */
function resolveDuration() {
  return new Promise((resolve) => {
    if (isFinite(video.duration) && video.duration > 0) { resolve(video.duration); return; }
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      video.removeEventListener("timeupdate", onUpdate);
      const d = video.duration;
      video.currentTime = 0;
      resolve(isFinite(d) && d > 0 ? d : 0);
    };
    const onUpdate = () => finish();
    // Some containers never fire timeupdate after the forced seek. Without this
    // fallback the editor would sit on "Loading video…" forever.
    const timer = setTimeout(finish, 4000);
    video.addEventListener("timeupdate", onUpdate);
    video.currentTime = 1e6; // seek past the end to force a duration scan
  });
}

// Clear everything that only means something for a clip. Called when a still
// takes over the window, and as the first step of loading a new clip.
function resetVideoState() {
  duration = 0;
  state.trimIn = 0;
  state.trimOut = 0;
  state.motion = null;
  state.zoomSegments = [];
  state.selectedSegId = null;
  if (pickingFocus) setPickingFocus(false);
  resetCursorTable();
}

function loadVideoSource(data) {
  if (!data || !(data.videoBytes instanceof Uint8Array)) return;
  const type = data.mimeType || "video/mp4";
  const blob = new Blob([data.videoBytes], { type });
  if (blobUrl) URL.revokeObjectURL(blobUrl);
  blobUrl = URL.createObjectURL(blob);

  // Reset for a fresh clip and show feedback while it decodes.
  source.kind = "video";
  source.el = video;
  source.loaded = false;
  source.naturalW = 0;
  source.naturalH = 0;
  state.crop = null;
  state.strokes = [];
  state.calloutCounter = 1;
  resetHistory();
  resetVideoState();
  state.motion = data.motion && Array.isArray(data.motion.events) ? data.motion : null;
  showVideoStatus("Loading video…", false);
  applyVideoChrome();
  // Set last: swapping the chrome can force the compose mode, which flags dirty.
  dirty = false;

  video.onloadedmetadata = () => {
    source.naturalW = video.videoWidth;
    source.naturalH = video.videoHeight;
    resolveDuration().then((d) => {
      duration = d || 0;
      if (!(duration > 0) || !(source.naturalW > 0) || !(source.naturalH > 0)) {
        showVideoStatus("Couldn't read this clip — the file may be incomplete or in an unsupported format.", true);
        return;
      }
      state.trimIn = 0;
      state.trimOut = duration;
      // Build the smoothed cursor table and auto-zoom segments now that we know
      // the true duration.
      buildCursorTable(state.motion, duration);
      if (state.motion && state.autoZoom) {
        state.zoomSegments = generateAutoZoom(state.motion, duration);
      }
      source.loaded = true;
      video.currentTime = 0;
      hideVideoStatus();
      updateEmptyState();
      syncMotionUI();
      setFormat(state.format);
      requestPaint();
      updateTransport();
    });
  };
  video.onerror = () => {
    console.error("Failed to load source video");
    showVideoStatus("Couldn't load this video. The file may be corrupt or in an unsupported format.", true);
  };
  video.src = blobUrl;
  video.load();
}

/* ───────────────────────── Video status overlay ───────────────────────── */
function showVideoStatus(msg, isError) {
  const el = document.getElementById("videoStatus");
  document.getElementById("videoStatusMsg").textContent = msg;
  el.classList.toggle("error", !!isError);
  el.classList.add("show");
}
function hideVideoStatus() { document.getElementById("videoStatus").classList.remove("show"); }

// Reveal or hide every media-kind-specific control in one place. A clip has a
// transport, a motion lane and encoder settings; a still has Copy/Save, import
// and the markup/compose toggle.
function applyVideoChrome() {
  const isVideo = isVideoSource();
  document.querySelectorAll(".video-only").forEach((el) => el.classList.toggle("hidden", !isVideo));
  document.querySelectorAll(".image-only").forEach((el) => el.classList.toggle("hidden", isVideo));
  document.getElementById("exportBtn").classList.toggle("hidden", !isVideo);
  document.getElementById("brandKind").textContent = isVideo ? "Reel" : "Mockup";
  // A clip is always composed: there is no "write a PNG back over the source".
  if (isVideo && editorMode !== "compose") setEditorMode("compose");
}

/* ───────────────────────── Wiring ───────────────────────── */
function initVideoUI() {
  document.getElementById("playBtn").addEventListener("click", togglePlay);

  /* Timeline: drag handles to trim, drag elsewhere to scrub. */
  const timeline = document.getElementById("timeline");
  const handleIn = document.getElementById("handleIn");
  const handleOut = document.getElementById("handleOut");
  let dragMode = null; // in | out | seek

  function timeFromClientX(clientX) {
    const rect = timeline.getBoundingClientRect();
    const f = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    return f * duration;
  }
  timeline.addEventListener("pointerdown", (e) => {
    if (!videoReady() || exporting) return;
    if (e.target === handleIn) dragMode = "in";
    else if (e.target === handleOut) dragMode = "out";
    else dragMode = "seek";
    timeline.setPointerCapture(e.pointerId);
    onTimelineMove(e);
  });
  function onTimelineMove(e) {
    if (!dragMode) return;
    const t = timeFromClientX(e.clientX);
    const minGap = Math.min(0.3, duration * 0.02);
    if (dragMode === "in") {
      state.trimIn = Math.max(0, Math.min(t, state.trimOut - minGap));
      seekPreview(state.trimIn);
    } else if (dragMode === "out") {
      state.trimOut = Math.min(duration, Math.max(t, state.trimIn + minGap));
      seekPreview(state.trimOut);
    } else {
      seekPreview(t);
    }
    updateTransport();
  }
  function onTimelineUp(e) {
    dragMode = null;
    try { timeline.releasePointerCapture(e.pointerId); } catch (_) {}
  }
  timeline.addEventListener("pointermove", onTimelineMove);
  timeline.addEventListener("pointerup", onTimelineUp);
  timeline.addEventListener("pointercancel", onTimelineUp);

  const loopBtn = document.getElementById("loopBtn");
  loopBtn.classList.toggle("active", state.loop);
  loopBtn.addEventListener("click", () => {
    if (exporting) return;
    state.loop = !state.loop;
    loopBtn.classList.toggle("active", state.loop);
  });

  document.getElementById("muteBtn").addEventListener("click", () => {
    if (exporting) return;
    state.muted = !state.muted;
    applyMute();
    refreshMuteBtn();
  });
  refreshMuteBtn();

  /* Motion lane. */
  const motionLane = document.getElementById("motionLane");
  let motionDrag = null; // { mode: move|resizeL|resizeR, id, grabDT }

  function timeFromLaneX(clientX) {
    const rect = motionLane.getBoundingClientRect();
    const f = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    return f * duration;
  }
  motionLane.addEventListener("pointerdown", (e) => {
    if (!videoReady() || exporting) return;
    const segEl = e.target.closest(".zseg");
    if (!segEl) {
      // Click empty lane, scrub the playhead there.
      selectSeg(null);
      seekPreview(timeFromLaneX(e.clientX));
      updateTransport();
      return;
    }
    const id = segEl.dataset.id;
    const seg = state.zoomSegments.find((s) => s.id === id);
    if (!seg) return;
    selectSeg(id);
    const edge = e.target.dataset.edge;
    const t = timeFromLaneX(e.clientX);
    motionDrag = edge === "l" ? { mode: "resizeL", id }
               : edge === "r" ? { mode: "resizeR", id }
               : { mode: "move", id, grabDT: t - seg.startT };
    motionLane.setPointerCapture(e.pointerId);
  });
  motionLane.addEventListener("pointermove", (e) => {
    if (!motionDrag) return;
    const seg = state.zoomSegments.find((s) => s.id === motionDrag.id);
    if (!seg) return;
    const t = timeFromLaneX(e.clientX);
    // Non-overlap bounds from immediate neighbors.
    sortSegments();
    const idx = state.zoomSegments.indexOf(seg);
    const prev = state.zoomSegments[idx - 1];
    const next = state.zoomSegments[idx + 1];
    const lo = prev ? prev.endT : 0;
    const hi = next ? next.startT : duration;
    const len = seg.endT - seg.startT;
    if (motionDrag.mode === "move") {
      let ns = t - motionDrag.grabDT;
      ns = Math.max(lo, Math.min(ns, hi - len));
      seg.startT = ns; seg.endT = ns + len;
    } else if (motionDrag.mode === "resizeL") {
      seg.startT = Math.max(lo, Math.min(t, seg.endT - MIN_SEG));
    } else {
      seg.endT = Math.min(hi, Math.max(t, seg.startT + MIN_SEG));
    }
    // Keep eases within half the (possibly shortened) length.
    const half = (seg.endT - seg.startT) / 2;
    seg.easeIn = Math.min(seg.easeIn, half);
    seg.easeOut = Math.min(seg.easeOut, half);
    renderMotionLane();
    markMotionDirty();
  });
  function onLaneUp(e) {
    if (motionDrag) { sortSegments(); syncMotionUI(); }
    motionDrag = null;
    try { motionLane.releasePointerCapture(e.pointerId); } catch (_) {}
  }
  motionLane.addEventListener("pointerup", onLaneUp);
  motionLane.addEventListener("pointercancel", onLaneUp);

  document.getElementById("addZoomBtn").addEventListener("click", () => {
    if (!videoReady() || exporting) return;
    const cur = video.currentTime;
    // Find a free window at the playhead that does not overlap neighbors.
    sortSegments();
    let endLimit = duration;
    for (const s of state.zoomSegments) { if (s.startT >= cur) { endLimit = Math.min(endLimit, s.startT); break; } }
    for (const s of state.zoomSegments) { if (cur >= s.startT && cur <= s.endT) return; } // inside one already
    const endT = Math.min(endLimit, cur + 2);
    if (endT - cur < MIN_SEG) return;
    const c = cursorAt(cur) || { x: 0.5, y: 0.5 };
    const seg = {
      id: zoomUid(), startT: cur, endT,
      cx: clampFocus(c.x, 1.8), cy: clampFocus(c.y, 1.8),
      scale: 1.8, easeIn: 0.4, easeOut: 0.5, source: "manual",
    };
    state.zoomSegments.push(seg);
    sortSegments();
    selectSeg(seg.id);
    markMotionDirty();
  });

  document.getElementById("delZoomBtn").addEventListener("click", () => {
    const seg = selectedSeg();
    if (!seg) return;
    state.zoomSegments = state.zoomSegments.filter((s) => s.id !== seg.id);
    selectSeg(null);
    markMotionDirty();
  });

  document.getElementById("regenZoomBtn").addEventListener("click", () => {
    if (!state.motion) return;
    // Replace auto segments, keep manual ones.
    const manual = state.zoomSegments.filter((s) => s.source === "manual");
    state.zoomSegments = manual.concat(generateAutoZoom(state.motion, duration));
    sortSegments();
    selectSeg(null);
    markMotionDirty();
  });

  /* Zoom inspector sliders. */
  const zoomScale = document.getElementById("zoomScale");
  const zoomEaseIn = document.getElementById("zoomEaseIn");
  const zoomEaseOut = document.getElementById("zoomEaseOut");
  zoomScale.addEventListener("input", () => {
    const seg = selectedSeg(); if (!seg) return;
    seg.scale = Math.max(1, zoomScale.value / 100);
    seg.cx = clampFocus(seg.cx, seg.scale);
    seg.cy = clampFocus(seg.cy, seg.scale);
    document.getElementById("zoomScaleValue").textContent = seg.scale.toFixed(1) + "×";
    renderMotionLane();
    markMotionDirty();
  });
  zoomEaseIn.addEventListener("input", () => {
    const seg = selectedSeg(); if (!seg) return;
    const half = (seg.endT - seg.startT) / 2;
    seg.easeIn = Math.min(half, zoomEaseIn.value / 100);
    document.getElementById("zoomEaseInValue").textContent = seg.easeIn.toFixed(1) + "s";
    markMotionDirty();
  });
  zoomEaseOut.addEventListener("input", () => {
    const seg = selectedSeg(); if (!seg) return;
    const half = (seg.endT - seg.startT) / 2;
    seg.easeOut = Math.min(half, zoomEaseOut.value / 100);
    document.getElementById("zoomEaseOutValue").textContent = seg.easeOut.toFixed(1) + "s";
    markMotionDirty();
  });

  document.getElementById("setFocusBtn").addEventListener("click", () => {
    if (!selectedSeg()) return;
    setPickingFocus(!pickingFocus);
  });

  /* Cursor style controls. */
  const cursorEnabled = document.getElementById("cursorEnabled");
  const cursorRipple = document.getElementById("cursorRipple");
  const cursorSize = document.getElementById("cursorSize");
  const cursorColor = document.getElementById("cursorColor");
  const cursorColorHex = document.getElementById("cursorColorHex");
  cursorEnabled.addEventListener("change", () => { state.cursor.enabled = cursorEnabled.checked; markMotionDirty(); });
  cursorRipple.addEventListener("change", () => { state.cursor.ripple = cursorRipple.checked; markMotionDirty(); });
  cursorSize.addEventListener("input", () => {
    state.cursor.size = cursorSize.value / 100;
    document.getElementById("cursorSizeValue").textContent = cursorSize.value;
    markMotionDirty();
  });
  cursorColor.addEventListener("input", () => {
    state.cursor.color = cursorColor.value;
    cursorColorHex.value = cursorColor.value.toUpperCase();
    markMotionDirty();
  });
  cursorColorHex.addEventListener("input", () => {
    const hex = normHex(cursorColorHex.value);
    if (hex) { state.cursor.color = hex; cursorColor.value = hex; markMotionDirty(); }
  });
  document.querySelectorAll("#cursorStyleTabs .seg").forEach((b) => {
    b.addEventListener("click", () => {
      state.cursor.style = b.dataset.cstyle;
      document.querySelectorAll("#cursorStyleTabs .seg").forEach((s) => s.classList.toggle("active", s === b));
      markMotionDirty();
    });
  });

  /* Format + export. */
  document.querySelectorAll("#formatTabs .seg").forEach((b) => {
    b.addEventListener("click", () => setFormat(b.dataset.format));
  });
  document.getElementById("exportBtn").addEventListener("click", startExport);
  document.getElementById("cancelExportBtn").addEventListener("click", () => {
    if (exportErrored) hideProgress();
    else exportAbort = true;
  });

  // Success is signalled by main destroying the window; only failures come back.
  window.studio.onExportError((message) => showExportError(message || "Export failed."));

  window.addEventListener("beforeunload", () => { if (blobUrl) URL.revokeObjectURL(blobUrl); });

  // Trim edits flag the session dirty so closing can warn first.
  document.querySelector(".transport").addEventListener("pointerdown", (e) => {
    if (e.target.closest("#timeline, #handleIn, #handleOut")) markDirty();
  }, true);
}

// Click-to-place the zoom focus point. Returns true when it consumed the click.
function handleFocusPick(e) {
  if (!pickingFocus) return false;
  const seg = selectedSeg();
  if (!seg) return false;
  const pt = clientToSource(e.clientX, e.clientY);
  if (!pt) return false;
  // Focus is normalized against the visible media region.
  seg.cx = clampFocus(Math.max(0, Math.min(1, (pt.x - cropX()) / srcW())), seg.scale);
  seg.cy = clampFocus(Math.max(0, Math.min(1, (pt.y - cropY()) / srcH())), seg.scale);
  setPickingFocus(false);
  markMotionDirty();
  return true;
}
