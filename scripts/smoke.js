// Headless smoke test for the Studio renderer.
//
// Boots a real (hidden) Electron window on studio.html, stubs the main-process
// IPC the preload talks to, feeds it a synthetic still and a synthetic clip,
// and then drives the editor from the renderer side. Anything that throws --
// an undefined global, a missing element, a broken export path -- shows up
// here instead of in a user's hands.
//
// Run with:  npm run smoke      (electron scripts/smoke.js)
const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const { assembleAnimation } = require("../lib/animation.js");

app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-gpu");

const root = path.join(__dirname, "..");
const results = [];
let pageErrors = [];
let consoleErrors = [];

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${ok || !detail ? "" : "\n      " + detail}`);
}

// ── Stub every channel studio-preload.js can reach ──
const ipcLog = [];
function stubOn(channel) {
  ipcMain.on(channel, (_e, ...args) => ipcLog.push({ channel, args }));
}
["studio-copy", "studio-save", "studio-overwrite", "studio-export-encoded",
 "studio-export-frames", "studio-cancel", "studio-set-always-on-top",
 "studio-save-colors", "studio-save-gradients"].forEach(stubOn);
ipcMain.handle("studio-get-colors", () => ["#6366F1", "#0F172A"]);
ipcMain.handle("studio-get-gradients", () => [{ angle: 90, c0: "#FF0000", c1: "#00FF00" }]);

// A 4x3 opaque PNG, generated inline so the test has no fixtures on disk.
const PNG_4x3 =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAIAAAA7ljmRAAAAG0lEQVQI12P8" +
  "z8DAwMDAxMDAwMDAAMEMDAwMAB8ZAgHwrH1BAAAAAElFTkSuQmCC";

async function evalIn(win, code) {
  return win.webContents.executeJavaScript(code, true);
}

async function run() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    webPreferences: {
      preload: path.join(root, "studio-preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      offscreen: true,
      backgroundThrottling: false,
    },
  });

  win.webContents.on("render-process-gone", (_e, d) => {
    pageErrors.push("render process gone: " + JSON.stringify(d));
  });
  win.webContents.on("console-message", (_e, level, message, line, sourceId) => {
    if (level >= 2) consoleErrors.push(`${message} (${sourceId}:${line})`);
  });
  win.webContents.on("preload-error", (_e, p, err) => {
    pageErrors.push("preload error: " + err.message);
  });

  await win.loadFile(path.join(root, "studio.html"));
  // Let the module scripts finish their first paint / async palette fetches.
  await new Promise((r) => setTimeout(r, 400));

  // ── 1. Boot: every module global resolved ──
  // Top-level const/let live in the global LEXICAL scope, not on globalThis, so
  // each name has to be referenced directly rather than looked up on an object.
  const NAMES = [
    "state", "source", "layout", "paintScene", "renderSceneScaled", "drawAnnotations",
    "cameraAt", "buildCursorTable", "generateAutoZoom", "initSidebar", "initVideoUI",
    "initAnnotationUI", "selectTool", "requestPaint", "showStudioToast", "composeImage",
    "setEditorMode", "applyVideoChrome", "loadImageSource", "loadVideoSource",
    "startExport", "estimateExportBytes", "syncSidebarToState", "normHex",
    "video", "previewCanvas", "previewArea", "undoStack", "savedGradients", "savedColors",
  ];
  const boot = await evalIn(win, `(() => {
    const missing = [];
    ${NAMES.map((n) => `if (typeof ${n} === "undefined") missing.push(${JSON.stringify(n)});`).join("\n    ")}
    return { missing, hasCanvas: !!document.getElementById("previewCanvas") };
  })()`);
  record("studio boots with every module global defined", boot.missing.length === 0, "missing: " + boot.missing.join(", "));
  record("preview canvas present", boot.hasCanvas);

  // ── 2. Still source loads and composes ──
  win.webContents.send("studio-load", { kind: "image", imageDataUrl: PNG_4x3, mode: "compose" });
  await new Promise((r) => setTimeout(r, 300));

  const still = await evalIn(win, `(() => {
    const L = layout();
    return {
      kind: source.kind, w: source.naturalW, h: source.naturalH,
      sceneW: Math.round(L.sceneW), sceneH: Math.round(L.sceneH),
      mode: editorMode, canvasHidden: previewCanvas.classList.contains("hidden"),
    };
  })()`);
  record("still source loaded", still.kind === "image" && still.w === 4 && still.h === 3, JSON.stringify(still));
  record("scene laid out with padding", still.sceneW > 4 && still.sceneH > 3, JSON.stringify(still));
  record("canvas revealed for a still", still.canvasHidden === false);

  // ── 3. Annotations survive a crop and export ──
  const annot = await evalIn(win, `(() => {
    state.tool = "draw";
    commitStroke({ type: "draw", points: [{x:0,y:0},{x:3,y:2}], color: "#ff3b30", width: 1 });
    commitStroke({ type: "callout", pos: {x:1,y:1}, number: 1, color: "#ff3b30", radius: 0.5 });
    commitStroke({ type: "text", text: "hi", pos: {x:1,y:2}, color: "#fff", fontPx: 2 });
    commitStroke({ type: "redact", from: {x:0,y:0}, to: {x:2,y:2}, style: "pixelate", block: 1 });
    commitStroke({ type: "cursor", pos: {x:2,y:1}, unit: 0.05 });
    const before = state.strokes.length;
    applyCrop({ x: 0, y: 0, w: 4, h: 3 });
    const cvs = composeImage();
    return { before, crop: state.crop, out: [cvs.width, cvs.height], undoDepth: undoStack.length };
  })()`);
  record("all stroke kinds commit", annot.before === 5, JSON.stringify(annot));
  record("crop below 8px is ignored (tiny source)", annot.crop === null, JSON.stringify(annot.crop));
  record("composeImage renders a bitmap", annot.out[0] > 0 && annot.out[1] > 0, JSON.stringify(annot.out));

  const undoRedo = await evalIn(win, `(() => {
    const n = state.strokes.length;
    undo(); const afterUndo = state.strokes.length;
    redo(); const afterRedo = state.strokes.length;
    return { n, afterUndo, afterRedo };
  })()`);
  record("undo removes the last stroke", undoRedo.afterUndo === undoRedo.n - 1, JSON.stringify(undoRedo));
  record("redo restores it", undoRedo.afterRedo === undoRedo.n, JSON.stringify(undoRedo));

  // ── 3b. The crop rect is adjustable before it is committed ──
  // Needs a source bigger than the minimum crop, so paint one in the renderer.
  await evalIn(win, `(() => {
    const c = document.createElement("canvas");
    c.width = 240; c.height = 160;
    const g = c.getContext("2d");
    g.fillStyle = "#4f46e5";
    g.fillRect(0, 0, 240, 160);
    loadImageSource(c.toDataURL("image/png"));
  })()`);
  await new Promise((r) => setTimeout(r, 300));

  const cropUI = await evalIn(win, `(() => {
    selectTool("crop");
    const armed = { ...cropSel };
    const rowHidden = document.getElementById("cropRow").classList.contains("hidden");
    const applyDisabled = document.getElementById("applyCropBtn").disabled;

    // Drag the east side inwards, the way a pointer would.
    cropDrag = { mode: "e", start: { x: 240, y: 80 }, orig: { ...cropSel } };
    dragCropSel({ x: 180, y: 80 });
    cropDrag = null;
    const resized = { ...cropSel };
    const dims = document.getElementById("cropDims").textContent;
    const applyEnabled = !document.getElementById("applyCropBtn").disabled;

    // A side hauled past the one opposite stops at the minimum size.
    cropDrag = { mode: "w", start: { x: 0, y: 80 }, orig: { ...cropSel } };
    dragCropSel({ x: 999, y: 80 });
    cropDrag = null;
    const pinned = { ...cropSel };

    // Dragging the inside moves the rect without resizing it, and it cannot
    // be shoved off the image.
    cropDrag = { mode: "move", start: { x: 176, y: 80 }, orig: { ...cropSel } };
    dragCropSel({ x: 999, y: 999 });
    cropDrag = null;
    const moved = { ...cropSel };

    const untouched = state.crop;
    commitCropSel();
    const committed = { ...state.crop };
    const reseeded = { ...cropSel };

    state.crop = null;
    selectTool("none");
    return { armed, rowHidden, applyDisabled, resized, dims, applyEnabled, pinned, moved,
             untouched, committed, reseeded, cleared: cropSel };
  })()`);
  record("picking crop arms a rect over the whole image",
    cropUI.armed.x === 0 && cropUI.armed.y === 0 && cropUI.armed.w === 240 && cropUI.armed.h === 160,
    JSON.stringify(cropUI.armed));
  record("the crop row shows, with Apply off until the rect trims something",
    cropUI.rowHidden === false && cropUI.applyDisabled === true, JSON.stringify(cropUI.rowHidden));
  record("dragging a side resizes the pending rect",
    cropUI.resized.x === 0 && cropUI.resized.w === 180 && cropUI.resized.h === 160, JSON.stringify(cropUI.resized));
  record("the size readout tracks the drag and Apply lights up",
    cropUI.dims.indexOf("180") === 0 && cropUI.dims.endsWith("160") && cropUI.applyEnabled, cropUI.dims);
  record("a side cannot be dragged past the opposite one",
    cropUI.pinned.x === 172 && cropUI.pinned.w === 8, JSON.stringify(cropUI.pinned));
  record("dragging inside moves the rect and stops at the edge",
    cropUI.moved.x === 232 && cropUI.moved.y === 0 && cropUI.moved.w === 8, JSON.stringify(cropUI.moved));
  record("adjusting the rect never touches state.crop", cropUI.untouched === null, JSON.stringify(cropUI.untouched));
  record("Apply commits the rect that was on screen",
    cropUI.committed.x === 232 && cropUI.committed.w === 8 && cropUI.committed.h === 160,
    JSON.stringify(cropUI.committed));
  record("the rect re-seeds over what is left after a crop",
    cropUI.reseeded.x === 232 && cropUI.reseeded.w === 8, JSON.stringify(cropUI.reseeded));
  record("leaving the tool drops the pending rect", cropUI.cleared === null, JSON.stringify(cropUI.cleared));

  // The rect now sits on screen for as long as the tool is armed, so an export
  // taken mid-crop must still come out clean.
  const cropExport = await evalIn(win, `(() => {
    selectTool("none");
    const plain = composeImage().toDataURL("image/png");
    selectTool("crop");
    cropDrag = { mode: "e", start: { x: 240, y: 80 }, orig: { ...cropSel } };
    dragCropSel({ x: 120, y: 80 });
    cropDrag = null;
    const armed = composeImage().toDataURL("image/png");
    selectTool("none");
    return plain === armed;
  })()`);
  record("an armed crop rect never reaches an export", cropExport === true);

  // ── 4. Every background / frame / aspect permutation paints ──
  const perms = await evalIn(win, `(() => {
    const errors = [];
    const modes = ["gradient", "wallpaper", "solid", "image"];
    const frames = ["none", "window", "browser"];
    const aspects = Object.keys(ASPECTS);
    for (const bg of modes) for (const fr of frames) for (const asp of aspects) {
      state.bgMode = bg; state.frame = fr; state.aspect = asp;
      try { composeImage(); } catch (e) { errors.push(bg + "/" + fr + "/" + asp + ": " + e.message); }
    }
    state.bgMode = "gradient"; state.frame = "window"; state.aspect = "auto";
    return errors;
  })()`);
  record("every background x frame x aspect combination paints", perms.length === 0, perms.join("; "));

  // ── 5. Saved gradients / colors round-trip through the stubbed IPC ──
  const palette = await evalIn(win, `(() => {
    state.gradientCustom = { angle: 45, c0: "#123456", c1: "#654321" };
    addSavedGradient();
    const added = savedGradients.length;
    addSavedGradient(); // duplicate, must be a no-op
    const afterDupe = savedGradients.length;
    addSavedColor("#ABCDEF");
    return { added, afterDupe, colors: savedColors.length, loadedGradients: added };
  })()`);
  record("custom gradient saves once, dedupes on repeat", palette.afterDupe === palette.added, JSON.stringify(palette));
  record("saved palettes loaded from main", palette.colors > 0, JSON.stringify(palette));

  // ── 6. Markup / compose mode round trip keeps the framing ──
  const modes = await evalIn(win, `(() => {
    setEditorMode("compose");
    state.padPct = 0.11; state.frame = "browser";
    setEditorMode("markup");
    const inMarkup = { pad: state.padPct, frame: state.frame, sidebar: document.querySelector(".sidebar").classList.contains("hidden") };
    setEditorMode("compose");
    const back = { pad: state.padPct, frame: state.frame };
    return { inMarkup, back };
  })()`);
  record("markup strips the framing and hides the sidebar",
    modes.inMarkup.pad === 0 && modes.inMarkup.frame === "none" && modes.inMarkup.sidebar === true,
    JSON.stringify(modes.inMarkup));
  record("returning to compose restores the framing",
    Math.abs(modes.back.pad - 0.11) < 1e-9 && modes.back.frame === "browser",
    JSON.stringify(modes.back));

  // ── 7. Motion maths are pure and bounded ──
  const motionMath = await evalIn(win, `(() => {
    const events = [];
    for (let i = 0; i < 200; i++) events.push({ t: i * 0.05, type: "move", x: i / 200, y: 0.5 });
    events.push({ t: 1.0, type: "down", x: 0.3, y: 0.4 });
    events.push({ t: 1.4, type: "down", x: 0.32, y: 0.42 });
    events.push({ t: 6.0, type: "down", x: 0.8, y: 0.8 });
    const data = { events, duration: 10 };
    buildCursorTable(data, 10);
    const segs = generateAutoZoom(data, 10);
    const overlap = segs.some((s, i) => i > 0 && s.startT < segs[i - 1].endT);
    const inRange = segs.every((s) => s.startT >= 0 && s.endT <= 10 && s.endT > s.startT);
    const focusClamped = segs.every((s) => {
      const half = 0.5 / s.scale;
      return s.cx >= half - 1e-9 && s.cx <= 1 - half + 1e-9;
    });
    state.zoomSegments = segs;
    const camIdentityBefore = cameraAt(-1).scale === 1;
    const camIn = segs.length ? cameraAt((segs[0].startT + segs[0].endT) / 2).scale : 1;
    const c = cursorAt(2.5);
    state.zoomSegments = [];
    return { n: segs.length, overlap, inRange, focusClamped, camIdentityBefore, camIn, cursor: c };
  })()`);
  record("auto-zoom produces non-overlapping in-range segments",
    motionMath.n > 0 && !motionMath.overlap && motionMath.inRange, JSON.stringify(motionMath));
  record("zoom focus stays inside the safe area", motionMath.focusClamped, JSON.stringify(motionMath));
  record("camera is identity outside a segment and zoomed inside",
    motionMath.camIdentityBefore && motionMath.camIn > 1, JSON.stringify(motionMath));
  record("smoothed cursor table interpolates", !!motionMath.cursor, JSON.stringify(motionMath.cursor));

  // ── 8. Coordinate round trip: source -> client -> source ──
  const coords = await evalIn(win, `(() => {
    requestPaint();
    return new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(() => {
      const p = sourceToClient(2, 1.5);
      if (!p) return res({ skipped: true });
      const back = clientToSource(p.x, p.y);
      res({ p, back, dx: Math.abs(back.x - 2), dy: Math.abs(back.y - 1.5) });
    })));
  })()`);
  record("source<->client mapping round-trips",
    coords.skipped || (coords.dx < 0.05 && coords.dy < 0.05), JSON.stringify(coords));

  // ── 9. Export-size estimator never returns nonsense ──
  const est = await evalIn(win, `(() => {
    const out = {};
    for (const f of ["mp4", "webm", "gif", "webp"]) {
      state.format = f; state.trimIn = 0; state.trimOut = 5;
      out[f] = estimateExportBytes();
    }
    state.trimIn = 0; state.trimOut = 0; state.format = "mp4";
    out.zeroSpan = estimateExportBytes();
    return out;
  })()`);
  record("size estimates are finite and positive",
    Object.values(est).every((v) => Number.isFinite(v) && v > 0), JSON.stringify(est));

  // ── 10. Clip source: load a real recorded WebM and drive the transport ──
  const clipBytes = await makeClipBytes(win);
  if (!clipBytes) {
    record("clip fixture recorded", false, "canvas.captureStream/MediaRecorder produced nothing");
  } else {
    record("clip fixture recorded", true);
    win.webContents.send("studio-load", {
      kind: "video",
      videoBytes: clipBytes,
      mimeType: "video/webm",
      motion: {
        version: 1,
        duration: 1.5,
        region: { x: 0, y: 0, width: 320, height: 240 },
        events: [
          { t: 0.1, type: "move", x: 0.1, y: 0.1 },
          { t: 0.5, type: "down", x: 0.5, y: 0.5 },
          { t: 0.6, type: "up", x: 0.5, y: 0.5 },
          { t: 1.0, type: "move", x: 0.9, y: 0.9 },
        ],
      },
      mode: "compose",
    });
    // Decoding + duration resolution is the slowest step in the harness.
    const loaded = await waitFor(win, `source.kind === "video" && source.loaded`, 8000);
    record("clip decodes and reports a finite duration", loaded, "timed out waiting for source.loaded");

    if (loaded) {
      const clip = await evalIn(win, `(() => ({
        duration, trimIn: state.trimIn, trimOut: state.trimOut,
        w: source.naturalW, h: source.naturalH,
        segs: state.zoomSegments.length,
        videoOnlyVisible: !document.querySelector(".transport").classList.contains("hidden"),
        imageOnlyHidden: document.getElementById("copyBtn").classList.contains("hidden"),
        mode: editorMode,
        dirty,
      }))()`);
      record("clip duration resolved", Number.isFinite(clip.duration) && clip.duration > 0, JSON.stringify(clip));
      record("trim range spans the whole clip", clip.trimIn === 0 && clip.trimOut === clip.duration, JSON.stringify(clip));
      record("clip chrome swaps to the video controls",
        clip.videoOnlyVisible && clip.imageOnlyHidden, JSON.stringify(clip));
      record("a clip always opens in compose mode", clip.mode === "compose", JSON.stringify(clip));
      record("seeding a clip does not flag the session dirty", clip.dirty === false, JSON.stringify(clip));

      const clipPaint = await evalIn(win, `(() => {
        const errors = [];
        state.cursor.enabled = true; state.cursor.ripple = true;
        for (const t of [0, 0.25, 0.5, 1.0]) {
          try { video.currentTime = Math.min(t, duration - 0.01); composeImage(); }
          catch (e) { errors.push(t + ": " + e.message); }
        }
        state.cursor.enabled = false;
        return errors;
      })()`);
      record("clip frames composite with cursor overlays", clipPaint.length === 0, clipPaint.join("; "));

      const trim = await evalIn(win, `(() => {
        state.trimIn = 0; state.trimOut = duration;
        state.loop = false;
        video.currentTime = duration;
        enforceTrim();
        const clamped = video.currentTime <= state.trimOut + 1e-6;
        state.loop = true;
        return { clamped, paused: video.paused };
      })()`);
      record("trim enforcement clamps the playhead", trim.clamped, JSON.stringify(trim));

      const zoomOps = await evalIn(win, `(() => {
        state.zoomSegments = [];
        video.currentTime = 0;
        document.getElementById("addZoomBtn").click();
        const added = state.zoomSegments.length;
        const sel = state.selectedSegId;
        document.getElementById("delZoomBtn").click();
        return { added, sel: !!sel, afterDelete: state.zoomSegments.length };
      })()`);
      record("zoom keyframes add and delete", zoomOps.added === 1 && zoomOps.afterDelete === 0, JSON.stringify(zoomOps));

      // ── 10b. Animation plans stay inside the main process memory budget ──
      const plans = await evalIn(win, `(() => {
        const out = [];
        for (const span of [1, 10, 60, 600]) {
          state.trimIn = 0; state.trimOut = Math.min(span, duration || span);
          const saved = state.trimOut;
          state.trimOut = span; // force a long span regardless of clip length
          for (const f of ["gif", "webp"]) {
            const p = animPlan(f);
            out.push({ span, f, w: p.w, h: p.h, total: p.total, fps: p.fps,
                       raw: p.w * p.h * 4 * p.total });
          }
          state.trimOut = saved;
        }
        state.trimIn = 0; state.trimOut = duration;
        return out;
      })()`);
      record("animated exports stay inside the raw memory budget",
        plans.every((p) => p.raw <= 384 * 1024 * 1024 && p.w >= 2 && p.h >= 2),
        JSON.stringify(plans.filter((p) => p.raw > 384 * 1024 * 1024)));
      record("animated exports stay inside the frame cap main enforces",
        plans.every((p) => p.total >= 1 && p.total <= 450 && p.fps > 0),
        JSON.stringify(plans.filter((p) => p.total > 450 || p.total < 1)));

      // ── 10bb. The fast (WebCodecs) render, end to end, in both containers ──
      const fastReady = await evalIn(win, `({
        supported: fastExportSupported(),
        hasMp4: typeof Mp4Muxer === "object" && typeof Mp4Muxer.Muxer === "function",
        hasWebm: typeof WebMMuxer === "object" && typeof WebMMuxer.Muxer === "function",
      })`);
      record("the fast export path and its muxers are available",
        fastReady.supported && fastReady.hasMp4 && fastReady.hasWebm, JSON.stringify(fastReady));

      // A real container has recognisable magic: MP4 carries "ftyp" at byte 4,
      // Matroska/WebM opens with the EBML header 0x1A45DFA3.
      const magicOf = (bytes) => {
        if (!bytes || bytes.length < 16) return "short";
        const ascii = Buffer.from(bytes.slice(4, 8)).toString("latin1");
        if (ascii === "ftyp") return "mp4";
        if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return "webm";
        return "unknown:" + Array.from(bytes.slice(0, 8)).join(",");
      };

      for (const format of ["mp4", "webm"]) {
        ipcLog.length = 0;
        const started = Date.now();
        await evalIn(win, `(() => {
          hideProgress();
          state.trimIn = 0;
          state.trimOut = Math.min(1.0, duration);
          state.muted = true;
          setFormat(${JSON.stringify(format)});
          startExport();
          return true;
        })()`);
        const ok = await waitUntil(() => ipcLog.some((e) => e.channel === "studio-export-encoded"), 60000);
        const elapsed = Date.now() - started;
        const out = (ipcLog.find((e) => e.channel === "studio-export-encoded") || { args: [] }).args[0];
        record(`a ${format.toUpperCase()} render reaches the encoder`, ok,
          "no studio-export-encoded within 60s; " + JSON.stringify(await evalIn(win, `({exporting, exportErrored})`)));
        record(`the rendered ${format.toUpperCase()} is a real container with a thumbnail`,
          !!out && out.bytes && out.bytes.length > 0 &&
          magicOf(out.bytes) === format &&
          typeof out.thumbnailDataUrl === "string" &&
          out.thumbnailDataUrl.startsWith("data:image/png") &&
          out.format === format,
          out ? `bytes=${out.bytes && out.bytes.length} magic=${magicOf(out.bytes)} format=${out.format} in ${elapsed}ms` : "no payload");
        // The point of this path is that it does not run at playback speed.
        // Assert on which encoder actually produced the clip rather than on the
        // clock: wall time here also carries IPC and the poll interval, so a
        // loaded machine would make a timing assertion flap.
        const clipMs = Math.round(await evalIn(win, `(state.trimOut - state.trimIn) * 1000`));
        console.log(`      ${format.toUpperCase()}: ${elapsed}ms of wall clock for ${clipMs}ms of clip ` +
                    `(${(clipMs / Math.max(1, elapsed)).toFixed(1)}x real time)`);
        const path = await evalIn(win, `lastExportPath`);
        record(`the ${format.toUpperCase()} render used the fast encoder, not the recorder`,
          ok && path === "fast", `path=${path}, took ${elapsed}ms for a ${clipMs}ms clip`);
      }

      // A clip with no audio track must mux as video-only rather than failing.
      const audioNone = await evalIn(win, `decodeTrimmedAudio(48000).then((a) => a === null)`);
      record("a clip with no audio exports as video only", audioNone === true, String(audioNone));
      const audioMuted = await evalIn(win, `(() => {
        state.muted = true;
        return decodeTrimmedAudio(48000).then((a) => a === null);
      })()`);
      record("muting drops the audio track from the export", audioMuted === true, String(audioMuted));

      // The real-time recorder is still the fallback, and still works.
      ipcLog.length = 0;
      await evalIn(win, `(() => {
        hideProgress();
        state.trimIn = 0; state.trimOut = Math.min(0.6, duration);
        state.muted = true;
        setFormat("webm");
        exportEncoded("webm");
        return true;
      })()`);
      const fellBack = await waitUntil(() => ipcLog.some((e) => e.channel === "studio-export-encoded"), 30000);
      const fbPayload = (ipcLog.find((e) => e.channel === "studio-export-encoded") || { args: [] }).args[0];
      const fbPath = await evalIn(win, `lastExportPath`);
      record("the real-time fallback still renders a clip",
        fellBack && !!fbPayload && fbPayload.bytes && fbPayload.bytes.length > 0 && fbPath === "realtime",
        fbPayload ? `path=${fbPath} bytes=${fbPayload.bytes && fbPayload.bytes.length}` : "no payload");

      await evalIn(win, `(() => { hideProgress(); state.trimOut = duration; state.muted = false; setFormat("mp4"); return true; })()`);

      // ── 10c. Export canvases are valid and untainted ──
      const canvases = await evalIn(win, `(() => {
        const enc = makeExportCanvas(ENCODED_MAX_LONG, true);
        const thumb = captureThumbnail();
        return {
          even: enc.w % 2 === 0 && enc.h % 2 === 0,
          size: [enc.w, enc.h],
          thumb: typeof thumb === "string" && thumb.startsWith("data:image/png"),
        };
      })()`);
      record("encoded export canvas has even dimensions", canvases.even, JSON.stringify(canvases));
      record("clip thumbnail exports (canvas is not tainted)", canvases.thumb, JSON.stringify(canvases));
    }
  }

  // ── 11. Output channels carry real PNG bytes on the right channel ──
  win.webContents.send("studio-load", { kind: "image", imageDataUrl: PNG_4x3, mode: "compose" });
  await new Promise((r) => setTimeout(r, 300));
  ipcLog.length = 0;
  await evalIn(win, `doCopy()`);
  await evalIn(win, `doSave()`);
  await new Promise((r) => setTimeout(r, 400));
  const composeChannels = ipcLog.map((e) => e.channel);
  record("compose mode copies and saves as a new capture",
    composeChannels.includes("studio-copy") && composeChannels.includes("studio-save"),
    composeChannels.join(", "));
  const pngArg = (ipcLog.find((e) => e.channel === "studio-copy") || {}).args;
  record("exported bytes are a real PNG",
    !!pngArg && pngArg[0] && pngArg[0][0] === 0x89 && pngArg[0][1] === 0x50,
    pngArg ? "first bytes: " + Array.from(pngArg[0].slice(0, 4)) : "no payload");

  ipcLog.length = 0;
  await evalIn(win, `setEditorMode("markup"); doSave();`);
  await new Promise((r) => setTimeout(r, 400));
  record("markup mode writes back over the source",
    ipcLog.some((e) => e.channel === "studio-overwrite"),
    ipcLog.map((e) => e.channel).join(", "));

  // ── 10d. Zoom and pan, and the coordinate mapping under them ──
  // A canvas-sized source, so there is something bigger than one screen pixel
  // per source pixel to zoom into.
  await evalIn(win, `(() => {
    const c = document.createElement("canvas");
    c.width = 1600; c.height = 900;
    const g = c.getContext("2d");
    g.fillStyle = "#111827"; g.fillRect(0, 0, 1600, 900);
    loadImageSource(c.toDataURL("image/png"));
  })()`);
  await new Promise((r) => setTimeout(r, 350));

  const zoom = await evalIn(win, `(() => {
    resetView();
    renderPreview();
    const base = previewCanvas.getBoundingClientRect().width;

    // Zooming grows the canvas, which is what keeps every coordinate helper
    // in annotate.js correct without knowing about zoom at all.
    zoomByStep(2);
    renderPreview();
    const zoomed = previewCanvas.getBoundingClientRect().width;

    // A source point must map to the same client point and back, at any zoom.
    const probe = { x: 400, y: 250 };
    const c1 = sourceToClient(probe.x, probe.y);
    const back = clientToSource(c1.x, c1.y);
    const roundTrips = Math.abs(back.x - probe.x) < 0.75 && Math.abs(back.y - probe.y) < 0.75;

    // Panning is clamped to zero while the whole scene fits...
    resetView();
    renderPreview();
    panBy(400, 400);
    renderPreview();
    const pannedWhenFitted = { x: view.panX, y: view.panY };

    // ...and allowed, but bounded, once it does not.
    view.zoom = 4;
    renderPreview();
    panBy(100000, 100000);
    renderPreview();
    const clamped = { x: view.panX, y: view.panY };
    const area = previewArea.getBoundingClientRect();
    const disp = previewCanvas.getBoundingClientRect();

    // Pan must not break the mapping either.
    const c2 = sourceToClient(probe.x, probe.y);
    const back2 = clientToSource(c2.x, c2.y);
    const roundTripsPanned = Math.abs(back2.x - probe.x) < 0.75 && Math.abs(back2.y - probe.y) < 0.75;

    const limits = { min: (zoomByStep(0.0001), view.zoom), max: (view.zoom = 99, renderPreview(), zoomByStep(2), view.zoom) };

    resetView();
    renderPreview();
    return {
      base, zoomed, roundTrips, pannedWhenFitted, clamped, roundTripsPanned,
      overX: (disp.width - area.width) / 2, limits,
      resetZoom: view.zoom, resetPan: [view.panX, view.panY],
      label: document.getElementById("zoomLabel").textContent,
      hudShown: !document.getElementById("zoomHud").classList.contains("hidden"),
    };
  })()`);
  record("zooming grows the preview canvas", zoom.zoomed > zoom.base * 1.9,
    JSON.stringify({ base: zoom.base, zoomed: zoom.zoomed }));
  record("source/client mapping round-trips while zoomed", zoom.roundTrips === true, String(zoom.roundTrips));
  record("pan is locked while the whole scene fits",
    zoom.pannedWhenFitted.x === 0 && zoom.pannedWhenFitted.y === 0, JSON.stringify(zoom.pannedWhenFitted));
  record("pan stops at the edge of a zoomed image",
    Math.abs(zoom.clamped.x - zoom.overX) < 1.5 && zoom.clamped.x > 0,
    JSON.stringify({ clamped: zoom.clamped, expected: zoom.overX }));
  record("source/client mapping round-trips while panned", zoom.roundTripsPanned === true, String(zoom.roundTripsPanned));
  record("zoom stays inside its limits",
    zoom.limits.min >= 0.1 - 1e-9 && zoom.limits.max <= 8 + 1e-9, JSON.stringify(zoom.limits));
  record("fit-to-window resets both zoom and pan",
    zoom.resetZoom === 1 && zoom.resetPan[0] === 0 && zoom.resetPan[1] === 0,
    JSON.stringify({ zoom: zoom.resetZoom, pan: zoom.resetPan }));
  record("the zoom readout reflects the view", zoom.label === "100%" && zoom.hudShown,
    JSON.stringify({ label: zoom.label, shown: zoom.hudShown }));

  // ── 11a. Placed annotations can be selected, moved, restyled and deleted ──
  win.webContents.send("studio-load", { kind: "image", imageDataUrl: PNG_4x3, mode: "compose" });
  await new Promise((r) => setTimeout(r, 300));

  const editing = await evalIn(win, `(() => {
    state.strokes = [];
    state.selectedStrokeId = null;
    resetHistory();
    selectTool("none");

    // Two overlapping marks, so "topmost wins" is actually exercised. Sizes are
    // in source pixels, so they are written at a realistic capture scale rather
    // than the fixture's 4x3.
    commitStroke({ type: "rect", from: { x: 100, y: 100 }, to: { x: 300, y: 200 }, color: "#ff3b30", width: 4 });
    commitStroke({ type: "callout", pos: { x: 200, y: 150 }, number: 1, color: "#007aff", radius: 40 });
    const rect = state.strokes[0], callout = state.strokes[1];

    const out = { ids: state.strokes.map((s) => s.id) };
    out.uniqueIds = new Set(out.ids).size === out.ids.length && out.ids.every((i) => i != null);

    // Hit testing: the callout is on top where they overlap; the rect is only
    // grabbable by its outline, not through its hollow middle.
    out.topmost = strokeAt({ x: 200, y: 150 }, 5) === callout;
    out.outline = strokeAt({ x: 100, y: 150 }, 5) === rect;
    out.hollow = strokeAt({ x: 260, y: 120 }, 2) === null;
    out.miss = strokeAt({ x: 390, y: 290 }, 2) === null;

    // Move the rect and check the whole shape travelled.
    state.selectedStrokeId = rect.id;
    const moved = translateStroke(rect, 50, 25);
    out.moved = moved.from.x === 150 && moved.to.x === 350 &&
                moved.from.y === 125 && moved.to.y === 225;
    out.movedIsNewObject = moved !== rect && rect.from.x === 100;

    // Resizing by a corner rewrites only the edges that corner owns.
    const resized = resizeBoxStroke(rect, "se", { x: 350, y: 250 });
    out.resized = resized.from.x === 100 && resized.from.y === 100 &&
                  resized.to.x === 350 && resized.to.y === 250;

    // Uniform scale about the opposite corner keeps the anchor still and
    // scales the mark's own size with it.
    const anchor = { x: 160, y: 110 };
    const scaled = scaleStroke(callout, 2, anchor);
    out.scaled = Math.abs(scaled.radius - 80) < 1e-9 &&
                 Math.abs(scaled.pos.x - 240) < 1e-9;

    // Restyling the selection edits the mark, and is undoable.
    const before = undoStack.length;
    updateSelectedStroke({ color: "#34c759" });
    out.recolored = state.strokes[0].color === "#34c759" && undoStack.length === before + 1;
    undo();
    out.recolorUndone = state.strokes[0].color === "#ff3b30";

    // Deleting removes exactly one mark and clears the selection.
    state.selectedStrokeId = callout.id;
    deleteSelectedStroke();
    out.deleted = state.strokes.length === 1 && state.selectedStrokeId === null;
    undo();
    out.deleteUndone = state.strokes.length === 2;

    // An undo that takes the selected mark away must not leave a dangling id.
    state.selectedStrokeId = state.strokes[1].id;
    deleteSelectedStroke();
    state.selectedStrokeId = 999999;
    undo();
    out.staleSelectionCleared = state.selectedStrokeId === null;

    return out;
  })()`);
  record("committed strokes get stable unique ids", editing.uniqueIds, JSON.stringify(editing.ids));
  record("hit testing picks the topmost mark", editing.topmost, String(editing.topmost));
  record("a hollow shape is grabbed by its outline, not its middle",
    editing.outline && editing.hollow, JSON.stringify(editing));
  record("a click on empty canvas selects nothing", editing.miss, String(editing.miss));
  record("moving a mark rewrites it without mutating the original",
    editing.moved && editing.movedIsNewObject, JSON.stringify(editing));
  record("a corner resize moves only that corner's edges", editing.resized, String(editing.resized));
  record("uniform scaling holds the opposite corner still", editing.scaled, String(editing.scaled));
  record("restyling the selection is one undoable edit",
    editing.recolored && editing.recolorUndone, JSON.stringify(editing));
  record("deleting a mark clears the selection and undoes cleanly",
    editing.deleted && editing.deleteUndone, JSON.stringify(editing));
  record("an undo past the selected mark drops the stale selection",
    editing.staleSelectionCleared, String(editing.staleSelectionCleared));

  const chrome = await evalIn(win, `(() => {
    state.strokes = [];
    resetHistory();
    commitStroke({ type: "rect", from: { x: 100, y: 100 }, to: { x: 300, y: 200 }, color: "#ff3b30", width: 4 });
    selectTool("none");
    state.selectedStrokeId = state.strokes[0].id;
    syncAnnotationUI();
    const rowShown = !document.getElementById("selectionRow").classList.contains("hidden");
    // Switching to any drawing tool must drop the selection.
    selectTool("draw");
    const cleared = state.selectedStrokeId === null &&
      document.getElementById("selectionRow").classList.contains("hidden");
    return { rowShown, cleared };
  })()`);
  record("the selection row appears for a selected mark", chrome.rowShown, JSON.stringify(chrome));
  record("picking a drawing tool drops the selection", chrome.cleared, JSON.stringify(chrome));

  // Selection chrome is editor-only: it must never reach an exported frame.
  const exportClean = await evalIn(win, `(() => {
    state.strokes = [];
    resetHistory();
    commitStroke({ type: "rect", from: { x: 100, y: 100 }, to: { x: 300, y: 200 }, color: "#ff3b30", width: 4 });
    selectTool("none");
    state.selectedStrokeId = state.strokes[0].id;
    // Compare pixels, not canvases: composeImage hands back a fresh element.
    const before = composeImage().toDataURL("image/png");
    state.selectedStrokeId = null;
    const after = composeImage().toDataURL("image/png");
    return before === after;
  })()`);
  record("the selection box never reaches an export", exportClean === true, String(exportClean));

  // ── 11b. Redaction cannot be undone by stacking marks ──
  // A pixelate block drawn over a solid block used to re-sample the pristine
  // source and paint the hidden pixels back in, at low resolution but often
  // still readable. Both orders must end up hiding the content.
  const redaction = await evalIn(win, `(async () => {
    const red = document.createElement("canvas");
    red.width = 200; red.height = 200;
    const rc = red.getContext("2d");
    rc.fillStyle = "#ff0000";
    rc.fillRect(0, 0, 200, 200);
    const url = red.toDataURL("image/png");

    await new Promise((res) => {
      const img = new Image();
      img.onload = () => {
        source.kind = "image"; source.el = img;
        source.naturalW = img.naturalWidth; source.naturalH = img.naturalHeight;
        source.loaded = true; state.crop = null; state.strokes = [];
        res();
      };
      img.src = url;
    });

    // Paint the media, then stack the two redactions over the same rect.
    const cvs = document.createElement("canvas");
    cvs.width = 200; cvs.height = 200;
    const ctx = cvs.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(source.el, 0, 0);
    const rect = { from: { x: 20, y: 20 }, to: { x: 160, y: 160 } };
    drawStroke(ctx, { type: "redact", style: "solid", ...rect });
    drawStroke(ctx, { type: "redact", style: "pixelate", block: 12, ...rect });

    // Sample well inside the redacted rect.
    const px = [];
    for (const [x, y] of [[40, 40], [90, 90], [140, 140]]) {
      const d = ctx.getImageData(x, y, 1, 1).data;
      px.push([d[0], d[1], d[2]]);
    }
    return { px, outside: Array.from(ctx.getImageData(5, 5, 1, 1).data).slice(0, 3) };
  })()`);
  record("pixelate over a solid block cannot re-expose the source",
    redaction.px.every(([r, g, b]) => r < 40 && g < 40 && b < 40),
    "sampled: " + JSON.stringify(redaction.px));
  record("redaction leaves pixels outside the rect alone",
    redaction.outside[0] > 200 && redaction.outside[1] < 40,
    "sampled: " + JSON.stringify(redaction.outside));

  // ── 12. The real GIF/WebP pipeline, end to end ──
  // Render frames in the page exactly the way exportAnimated does, then hand
  // them to the same assembler the main process uses.
  const frameArrays = await evalIn(win, `(() => {
    const plan = animPlan("gif");
    const { cvs, ctx, w, h, L } = makeExportCanvas(Math.min(plan.maxLong, 160), false);
    const out = [];
    const step = (i) => new Promise((res) => {
      renderSceneScaled(ctx, w / L.sceneW, h / L.sceneH, L);
      cvs.toBlob((b) => b.arrayBuffer().then((buf) => { out.push(Array.from(new Uint8Array(buf))); res(); }), "image/png");
    });
    return step(0).then(() => step(1)).then(() => step(2)).then(() => ({ frames: out, w, h }));
  })()`);
  const animFrames = frameArrays.frames.map((a) => new Uint8Array(a));

  for (const format of ["gif", "webp"]) {
    const res = await assembleAnimation({
      frames: animFrames,
      delays: animFrames.map(() => 66),
      width: frameArrays.w,
      height: frameArrays.h,
      format,
    });
    const magic = res.ok ? Array.from(res.buffer.slice(0, 4)) : null;
    const validGif = format === "gif" && res.ok && res.buffer.slice(0, 3).toString("latin1") === "GIF";
    const validWebp = format === "webp" && res.ok && res.buffer.slice(0, 4).toString("latin1") === "RIFF";
    record(`assembles a real animated ${format.toUpperCase()}`,
      res.ok && (validGif || validWebp) && res.ext === format,
      res.ok ? "magic: " + JSON.stringify(magic) : res.reason);
  }

  // Rejections must be graceful, never a throw.
  const badPayloads = [
    [{ frames: [], width: 10, height: 10, format: "gif" }, "no frames"],
    [{ frames: animFrames, width: 0, height: 10, format: "gif" }, "zero width"],
    [{ frames: animFrames, width: 10, height: 10, format: "avi" }, "unknown format"],
    [{ frames: ["not binary"], width: 10, height: 10, format: "gif" }, "non-binary frame"],
    [{ frames: new Array(2000).fill(animFrames[0]), width: 10, height: 10, format: "gif" }, "over the frame cap"],
    [{ frames: new Array(400).fill(animFrames[0]), width: 4000, height: 4000, format: "gif" }, "over the memory budget"],
    [null, "null payload"],
  ];
  let rejected = 0;
  for (const [payload, label] of badPayloads) {
    let res;
    try { res = await assembleAnimation(payload); } catch (e) { res = { ok: true, threw: e.message }; }
    if (res && res.ok === false && res.userMessage) rejected++;
    else console.log("      unexpected acceptance:", label, JSON.stringify(res && res.threw));
  }
  record("bad animation payloads are rejected, never thrown",
    rejected === badPayloads.length, `${rejected}/${badPayloads.length} rejected cleanly`);

  // ── 13. The main-process handoff survives arriving early ──
  // Main sends "studio-load" on ready-to-show, which can land before the eight
  // script tags in studio.html have run and registered a handler. The preload
  // has to hold the payload until the renderer asks for it; without that, the
  // editor opens stuck on its import prompt.
  await checkEarlyHandoff();

  // ── 14. No stray errors anywhere along the way ──
  record("no uncaught page errors", pageErrors.length === 0, pageErrors.join(" | "));
  record("no console errors", consoleErrors.length === 0, consoleErrors.join(" | "));

  win.destroy();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length) {
    console.error(`${failed.length} smoke check(s) failed.`);
    app.exit(1);
  } else {
    console.log("Studio smoke test passed.");
    app.exit(0);
  }
}

// Send the source before anything in the page could have subscribed, then
// subscribe late and check the payload was still waiting.
async function checkEarlyHandoff() {
  const win = new BrowserWindow({
    width: 400,
    height: 300,
    show: false,
    webPreferences: {
      preload: path.join(root, "studio-preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      offscreen: true,
    },
  });
  try {
    await win.loadURL("about:blank");
    win.webContents.send("studio-load", { kind: "image", imageDataUrl: PNG_4x3, mode: "markup" });
    await new Promise((r) => setTimeout(r, 300));
    const got = await evalIn(win, `new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ kind: "TIMED-OUT" }), 2000);
      window.studio.onLoad((d) => { clearTimeout(timer); resolve({ kind: d.kind, mode: d.mode, url: d.imageDataUrl }); });
    })`);
    record("a source sent before the page subscribes is not dropped",
      got.kind === "image" && got.mode === "markup" && got.url === PNG_4x3, JSON.stringify(got.kind));
  } catch (e) {
    record("a source sent before the page subscribes is not dropped", false, e.message);
  } finally {
    win.destroy();
  }
}

// Record a short clip in the renderer so the test has a real, decodable video
// without shipping a binary fixture.
async function makeClipBytes(win) {
  try {
    const arr = await evalIn(win, `(() => new Promise((resolve) => {
      const c = document.createElement("canvas");
      c.width = 320; c.height = 240;
      const cx = c.getContext("2d", { alpha: false });
      let f = 0;
      const draw = () => { cx.fillStyle = f % 2 ? "#123" : "#456"; cx.fillRect(0,0,320,240); f++; };
      draw();
      const stream = c.captureStream(30);
      let rec;
      try { rec = new MediaRecorder(stream, { mimeType: "video/webm;codecs=vp9" }); }
      catch (e) { resolve(null); return; }
      const chunks = [];
      rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      rec.onstop = async () => {
        const blob = new Blob(chunks, { type: "video/webm" });
        const buf = await blob.arrayBuffer();
        resolve(Array.from(new Uint8Array(buf)));
      };
      rec.start(100);
      const iv = setInterval(draw, 33);
      setTimeout(() => { clearInterval(iv); rec.stop(); }, 1500);
    }))()`);
    return arr && arr.length ? new Uint8Array(arr) : null;
  } catch (e) {
    return null;
  }
}

// Poll a main-process predicate (used for "did this IPC arrive yet").
async function waitUntil(fn, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

async function waitFor(win, expr, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await evalIn(win, `!!(${expr})`)) return true;
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

app.whenReady().then(() => {
  run().catch((e) => {
    console.error("Smoke test crashed:", e);
    app.exit(1);
  });
});
