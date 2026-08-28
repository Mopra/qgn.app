// Headless smoke test for the capture overlay.
//
// Boots a real (hidden) Electron window on overlay.html with the real
// preload.js, stubs the main-process IPC it talks to, and drives the selection
// the way a user would: drag, adjust, confirm. The overlay is the one surface
// where a regression costs the user their capture, and it is pure event
// handling, so it is worth driving end to end.
//
// Run with:  npm run smoke:overlay      (electron scripts/smoke-overlay.js)
const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");

app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-gpu");

const root = path.join(__dirname, "..");
const results = [];
const pageErrors = [];
const consoleErrors = [];

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${ok || !detail ? "" : "\n      " + detail}`);
}

// ── Stub the channels preload.js can reach ──
const ipcLog = [];
for (const ch of ["capture-region", "start-video-recording", "cancel", "close-mic-dropdown"]) {
  ipcMain.on(ch, (_e, ...args) => ipcLog.push({ channel: ch, args }));
}

// A fixed 4-window layout, so snapping has something deterministic to hit.
const WINDOW_RECTS = [
  { x: 100, y: 100, w: 400, h: 300 },
  { x: 600, y: 150, w: 300, h: 200 },
  { x: 120, y: 120, w: 100, h: 80 }, // nested inside the first
];
let magnifyCalls = 0;
ipcMain.handle("overlay-window-rects", () => WINDOW_RECTS);
ipcMain.handle("overlay-magnify", (_e, req) => {
  magnifyCalls++;
  if (!req || !Number.isFinite(req.x)) return null;
  // A 1x1 transparent PNG is enough: the loupe only has to not throw.
  return {
    dataUrl:
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    cx: 0, cy: 0, w: 1, h: 1, hex: "#112233",
  };
});

function evalIn(win, code) {
  return win.webContents.executeJavaScript(code, true);
}

// Synthesize a mouse gesture inside the page. sendInputEvent goes through the
// real event pipeline, so the overlay's own listeners run untouched.
function mouse(win, type, x, y, opts = {}) {
  win.webContents.sendInputEvent({
    type,
    x: Math.round(x),
    y: Math.round(y),
    button: "left",
    clickCount: opts.clickCount || 1,
    modifiers: opts.modifiers || [],
  });
}

function key(win, keyCode, modifiers = []) {
  win.webContents.sendInputEvent({ type: "keyDown", keyCode, modifiers });
  win.webContents.sendInputEvent({ type: "char", keyCode, modifiers });
  win.webContents.sendInputEvent({ type: "keyUp", keyCode, modifiers });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function drag(win, x1, y1, x2, y2, modifiers = []) {
  mouse(win, "mouseDown", x1, y1, { modifiers });
  await wait(30);
  mouse(win, "mouseMove", (x1 + x2) / 2, (y1 + y2) / 2, { modifiers });
  await wait(30);
  mouse(win, "mouseMove", x2, y2, { modifiers });
  await wait(30);
  mouse(win, "mouseUp", x2, y2, { modifiers });
  await wait(60);
}

async function state(win) {
  return evalIn(win, `({ phase, mode, sel: { ...sel }, confirmSelection, rects: windowRects.length })`);
}

async function run() {
  const win = new BrowserWindow({
    width: 1000,
    height: 700,
    show: false,
    webPreferences: {
      preload: path.join(root, "preload.js"),
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

  await win.loadFile(path.join(root, "overlay.html"));
  await wait(300);

  // ── 1. Boot ──
  // Top-level const/let live in the global LEXICAL scope, not on globalThis, so
  // each name has to be referenced directly rather than looked up dynamically.
  const NAMES = [
    "confirmSelectionNow", "clearSelection", "snapRect", "windowAt",
    "handleAt", "clampMove", "clampRect", "rectFromPoints", "requestLoupe",
    "resizeBy", "applyOptions", "loadWindowRects",
  ];
  const boot = await evalIn(win, `(() => {
    const missing = [];
    ${NAMES.map((n) => `if (typeof ${n} !== "function") missing.push(${JSON.stringify(n)});`).join("\n    ")}
    return { hasQgn: typeof window.qgn === "object", phase, mode, missing };
  })()`);
  record("overlay boots with its preload bridge",
    boot.hasQgn && boot.missing.length === 0, JSON.stringify(boot));

  // ── 2. Activation seeds mode and options ──
  win.webContents.send("activate-capture", { displayId: "1", confirmSelection: true });
  await wait(250); // let the window-rect fetch land
  let s = await state(win);
  record("activation resets to idle and loads window rects",
    s.phase === "idle" && s.mode === "screenshot" && s.confirmSelection === true &&
    s.rects === WINDOW_RECTS.length,
    JSON.stringify(s));

  // ── 3. A drag settles into an adjustable selection, it does not capture ──
  ipcLog.length = 0;
  await drag(win, 700, 400, 850, 500);
  s = await state(win);
  record("releasing the mouse settles the selection instead of capturing",
    s.phase === "adjusting" && !ipcLog.some((e) => e.channel === "capture-region"),
    JSON.stringify({ s, ipc: ipcLog.map((e) => e.channel) }));
  record("the settled selection matches the dragged rect",
    s.sel.w === 150 && s.sel.h === 100 && s.sel.x === 700 && s.sel.y === 400,
    JSON.stringify(s.sel));

  // ── 4. Handles resize, and the rect stays on screen ──
  await evalIn(win, `(() => { sel = { x: 700, y: 400, w: 150, h: 100 }; scheduleRender(); return true; })()`);
  await wait(50);
  // Grab the south-east grip and pull it out by 50x40.
  mouse(win, "mouseDown", 850, 500);
  await wait(30);
  mouse(win, "mouseMove", 900, 540);
  await wait(30);
  mouse(win, "mouseUp", 900, 540);
  await wait(60);
  s = await state(win);
  record("dragging a corner grip resizes the selection",
    s.phase === "adjusting" && s.sel.w === 200 && s.sel.h === 140,
    JSON.stringify(s.sel));

  // ── 5. Arrow keys nudge ──
  const before = (await state(win)).sel;
  key(win, "Right");
  key(win, "Down");
  await wait(60);
  let after = (await state(win)).sel;
  record("arrow keys nudge the selection by a pixel",
    after.x === before.x + 1 && after.y === before.y + 1,
    JSON.stringify({ before, after }));

  key(win, "Right", ["shift"]);
  await wait(60);
  const grown = (await state(win)).sel;
  record("shift+arrow resizes instead of moving",
    grown.w === after.w + 1 && grown.x === after.x,
    JSON.stringify({ after, grown }));

  // ── 6. Enter confirms and reports the rect ──
  ipcLog.length = 0;
  key(win, "Return");
  await wait(120);
  const captured = ipcLog.find((e) => e.channel === "capture-region");
  s = await state(win);
  record("Enter confirms the selection", !!captured,
    "ipc: " + ipcLog.map((e) => e.channel).join(", "));
  record("the confirmed region carries the viewport it was measured in",
    !!captured && captured.args[0].width === grown.w && captured.args[0].height === grown.h &&
    captured.args[0].viewportWidth > 0 && captured.args[0].viewportHeight > 0,
    captured ? JSON.stringify(captured.args[0]) : "no capture");
  record("confirming clears the overlay back to idle", s.phase === "idle", s.phase);

  // ── 7. Escape backs out of a selection before it cancels the overlay ──
  win.webContents.send("activate-capture", { displayId: "1", confirmSelection: true });
  await wait(200);
  ipcLog.length = 0;
  await drag(win, 300, 300, 420, 380);
  key(win, "Escape");
  await wait(80);
  s = await state(win);
  record("Escape drops the selection without cancelling the overlay",
    s.phase === "idle" && !ipcLog.some((e) => e.channel === "cancel"),
    JSON.stringify({ s, ipc: ipcLog.map((e) => e.channel) }));

  key(win, "Escape");
  await wait(80);
  record("a second Escape cancels the overlay",
    ipcLog.some((e) => e.channel === "cancel"),
    ipcLog.map((e) => e.channel).join(", "));

  // ── 8. Snapping ──
  const snapped = await evalIn(win, `(() => {
    // A rect whose edges sit just inside a known window should stick to it.
    const r = snapRect({ x: 104, y: 103, w: 392, h: 294 });
    const far = snapRect({ x: 700, y: 600, w: 50, h: 40 });
    return { r, far };
  })()`);
  record("edges within the snap distance stick to a window",
    snapped.r.x === 100 && snapped.r.y === 100 &&
    snapped.r.w === 400 && snapped.r.h === 300,
    JSON.stringify(snapped.r));
  record("edges far from any window are left alone",
    snapped.far.x === 700 && snapped.far.y === 600 &&
    snapped.far.w === 50 && snapped.far.h === 40,
    JSON.stringify(snapped.far));

  const hit = await evalIn(win, `(() => ({
    nested: windowAt(150, 150),
    outer: windowAt(450, 350),
    none: windowAt(950, 650),
  }))()`);
  record("the smallest window under the cursor wins",
    hit.nested && hit.nested.w === 100 && hit.outer && hit.outer.w === 400 && hit.none === null,
    JSON.stringify(hit));

  // ── 9. Clicking (not dragging) takes the window under the cursor ──
  win.webContents.send("activate-capture", { displayId: "1", confirmSelection: true });
  await wait(200);
  mouse(win, "mouseDown", 650, 200);
  await wait(30);
  mouse(win, "mouseUp", 650, 200);
  await wait(80);
  s = await state(win);
  record("a click selects the window under the cursor",
    s.phase === "adjusting" && s.sel.x === 600 && s.sel.y === 150 &&
    s.sel.w === 300 && s.sel.h === 200,
    JSON.stringify(s.sel));

  // ── 10. Instant mode (the default): releasing captures straight away ──
  win.webContents.send("activate-capture", { displayId: "1", confirmSelection: false });
  await wait(200);
  ipcLog.length = 0;
  await drag(win, 200, 200, 320, 290);
  await wait(100);
  s = await state(win);
  record("with confirmation off, releasing captures straight away",
    ipcLog.some((e) => e.channel === "capture-region") && s.phase === "idle",
    JSON.stringify({ phase: s.phase, ipc: ipcLog.map((e) => e.channel) }));

  const instantHint = await evalIn(win, `$instr.textContent`);
  record("instant mode advertises Alt-to-adjust in the instructions",
    instantHint.includes("Alt to adjust"), instantHint);

  // ── 10b. Alt at release flips the behaviour for that one capture ──
  // Instant mode + Alt: the selection settles instead of being taken.
  ipcLog.length = 0;
  await drag(win, 200, 200, 330, 300, ["alt"]);
  s = await state(win);
  record("Alt at release settles the selection in instant mode",
    s.phase === "adjusting" && !ipcLog.some((e) => e.channel === "capture-region"),
    JSON.stringify({ phase: s.phase, ipc: ipcLog.map((e) => e.channel) }));
  key(win, "Escape");
  await wait(80);

  // Adjust mode + Alt: the capture is taken immediately.
  win.webContents.send("activate-capture", { displayId: "1", confirmSelection: true });
  await wait(200);
  ipcLog.length = 0;
  await drag(win, 200, 200, 330, 300, ["alt"]);
  await wait(100);
  s = await state(win);
  record("Alt at release captures immediately in adjust mode",
    ipcLog.some((e) => e.channel === "capture-region") && s.phase === "idle",
    JSON.stringify({ phase: s.phase, ipc: ipcLog.map((e) => e.channel) }));

  // Snapping's bypass moved to Ctrl so it cannot collide with Alt's meaning.
  // Same drag twice, ending 4px from a window corner: plain snaps to the
  // window's 500,400 corner, Ctrl leaves the raw rect alone.
  win.webContents.send("activate-capture", { displayId: "1", confirmSelection: false });
  await wait(200);
  ipcLog.length = 0;
  await drag(win, 200, 200, 496, 396);
  await wait(100);
  const snapped2 = (ipcLog.find((e) => e.channel === "capture-region") || { args: [{}] }).args[0];
  ipcLog.length = 0;
  await drag(win, 200, 200, 496, 396, ["control"]);
  await wait(100);
  const unsnapped = (ipcLog.find((e) => e.channel === "capture-region") || { args: [{}] }).args[0];
  record("a plain drag snaps to a window edge; Ctrl bypasses it",
    snapped2.width === 300 && snapped2.height === 200 &&
    unsnapped.width === 296 && unsnapped.height === 196,
    JSON.stringify({ plain: [snapped2.width, snapped2.height], ctrl: [unsnapped.width, unsnapped.height] }));

  // ── 11. Video mode keeps its mode across a back-out ──
  win.webContents.send("overlay-reset-video", { confirmSelection: true });
  await wait(200);
  await drag(win, 400, 400, 500, 470);
  key(win, "Escape");
  await wait(80);
  s = await state(win);
  record("backing out of a recording area stays in video mode",
    s.mode === "video" && s.phase === "idle", JSON.stringify(s));

  ipcLog.length = 0;
  await drag(win, 400, 400, 520, 480);
  key(win, "Return");
  await wait(120);
  record("confirming in video mode starts a recording, not a capture",
    ipcLog.some((e) => e.channel === "start-video-recording") &&
    !ipcLog.some((e) => e.channel === "capture-region"),
    ipcLog.map((e) => e.channel).join(", "));

  // ── 12. Space grabs the whole display in both modes ──
  win.webContents.send("overlay-reset-video", { confirmSelection: true });
  await wait(150);
  ipcLog.length = 0;
  key(win, "Space");
  await wait(120);
  record("Space records the full screen in video mode",
    ipcLog.some((e) => e.channel === "start-video-recording"),
    ipcLog.map((e) => e.channel).join(", "));

  win.webContents.send("activate-capture", { displayId: "1", confirmSelection: true });
  await wait(200);
  ipcLog.length = 0;
  key(win, "Space");
  await wait(120);
  record("Space captures the full screen in screenshot mode",
    ipcLog.some((e) => e.channel === "capture-region"),
    ipcLog.map((e) => e.channel).join(", "));

  // ── 13. The loupe asks main for crops while aiming ──
  win.webContents.send("activate-capture", { displayId: "1", confirmSelection: true });
  await wait(200);
  magnifyCalls = 0;
  mouse(win, "mouseMove", 500, 500);
  await wait(60);
  mouse(win, "mouseMove", 505, 505);
  await wait(150);
  record("moving the cursor requests a loupe crop", magnifyCalls > 0,
    "magnify calls: " + magnifyCalls);
  const loupeShown = await evalIn(win, `$loupe.classList.contains("show")`);
  record("the loupe renders the crop it gets back", loupeShown === true, String(loupeShown));

  // ── 14. Nothing threw along the way ──
  record("no uncaught page errors", pageErrors.length === 0, pageErrors.join("\n      "));
  record("no console errors", consoleErrors.length === 0, consoleErrors.join("\n      "));

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length) {
    console.error(`${failed.length} overlay check(s) failed.`);
    app.exit(1);
  } else {
    console.log("Overlay smoke test passed.");
    app.exit(0);
  }
}

app.whenReady().then(() => {
  run().catch((e) => {
    console.error("Overlay smoke test crashed:", e);
    app.exit(1);
  });
});
