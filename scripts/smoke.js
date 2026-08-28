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
    applyCrop({ from: { x: 0, y: 0 }, to: { x: 4, y: 3 } });
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

      // ── 10bb. A real end-to-end WebM render through MediaRecorder ──
      // Trim to a short slice so the real-time render finishes quickly.
      ipcLog.length = 0;
      await evalIn(win, `(() => {
        state.trimIn = 0;
        state.trimOut = Math.min(0.6, duration);
        state.muted = true;
        setFormat("webm");
        startExport();
        return true;
      })()`);
      const exported = await waitUntil(() => ipcLog.some((e) => e.channel === "studio-export-encoded"), 30000);
      const payload = (ipcLog.find((e) => e.channel === "studio-export-encoded") || { args: [] }).args[0];
      record("real-time clip render reaches the encoder", exported,
        "no studio-export-encoded within 30s; " + JSON.stringify(await evalIn(win, `({exporting, exportErrored})`)));
      record("rendered clip has bytes and a thumbnail",
        !!payload && payload.bytes && payload.bytes.length > 0 &&
        typeof payload.thumbnailDataUrl === "string" &&
        payload.thumbnailDataUrl.startsWith("data:image/png") &&
        ["mp4", "webm"].includes(payload.format),
        payload ? `bytes=${payload.bytes && payload.bytes.length} format=${payload.format}` : "no payload");

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

  // ── 13. No stray errors anywhere along the way ──
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
