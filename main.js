// QGN – Quick screenshot capture tool
const {
  app,
  BrowserWindow,
  globalShortcut,
  desktopCapturer,
  clipboard,
  nativeImage,
  screen,
  ipcMain,
  Tray,
  Menu,
  dialog,
  shell,
} = require("electron");
const path = require("path");
const fs = require("fs");
// Lazy-loaded to avoid crash when running in CLI mode
let _autoUpdater;
function getAutoUpdater() {
  if (!_autoUpdater) _autoUpdater = require("electron-updater").autoUpdater;
  return _autoUpdater;
}

// ── Constants ──
const CARD_WIDTH = 260;
const SHADOW_PAD = 40;
const PREVIEW_MARGIN = 20;
const PREVIEW_GAP = 8;
const TOAST_OFFSET_Y = 120;
const TOAST_DURATION_MS = 3100;
const ANNOTATION_AREA_FRACTION = 0.85;
const ANNOTATION_PAD = 80;
const ANNOTATION_TOOLBAR_H = 48;
const MIN_ANNOTATION_W = 660;
const MIN_ANNOTATION_H = 400;
const PREVIEW_MIN_IMG_H = 80;
const PREVIEW_MAX_IMG_H = 200;
const BOUNDS_DEBOUNCE_MS = 200;

// Shared webPreferences for secure BrowserWindows
const secureWebPrefs = (preloadFile, opts = {}) => ({
  preload: path.join(__dirname, preloadFile),
  nodeIntegration: false,
  contextIsolation: true,
  sandbox: true,
  ...opts,
});

// ── CLI mode ──
// Usage: qgn capture  (takes a fullscreen screenshot, copies to clipboard, saves to disk, exits)
const cliMode = process.argv.includes("capture");

if (!app.isPackaged) {
  try {
    require("electron-reloader")(module);
  } catch (_) {}
}

// Software rendering avoids GPU compositing conflicts with hardware-accelerated
// video in other apps (e.g. YouTube goes black under transparent windows)
app.disableHardwareAcceleration();

let configPath = path.join(
  app.getPath("userData"),
  "settings.json"
);

function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf-8"));
  } catch {
    return {};
  }
}

function saveSetting(key, value) {
  const settings = loadSettings();
  settings[key] = value;
  const tmp = configPath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2));
  fs.renameSync(tmp, configPath);
}

function getSaveFolder() {
  return loadSettings().saveFolder || path.join(app.getPath("pictures"), "qgn");
}

function getSaveToDisk() {
  const settings = loadSettings();
  return settings.saveToDisk !== false; // default true
}

function getCopyFormat() {
  return loadSettings().copyFormat || "png";
}

function getRecordFormat() {
  return loadSettings().recordFormat === "gif" ? "gif" : "mp4";
}

const defaultHotkeys = {
  capture: "CommandOrControl+Q",
  record: "CommandOrControl+Shift+Q",
};

function getStartOnStartup() {
  const settings = loadSettings();
  return settings.startOnStartup !== false; // default true
}

function getHotkeys() {
  const settings = loadSettings();
  return {
    capture: settings.hotkey_capture || defaultHotkeys.capture,
    record: settings.hotkey_record || defaultHotkeys.record,
  };
}

function hotkeyToLabel(accelerator) {
  return accelerator
    .replace("CommandOrControl", "Ctrl")
    .replace("CmdOrCtrl", "Ctrl")
    .replace("Control", "Ctrl")
    .replace("Command", "Ctrl")
    .replace(/\+/g, "+");
}

function registerHotkeys() {
  globalShortcut.unregisterAll();
  const hk = getHotkeys();
  try {
    globalShortcut.register(hk.capture, showOverlay);
  } catch (e) {
    console.error("Failed to register capture hotkey:", e);
  }
  try {
    globalShortcut.register(hk.record, showOverlayForVideo);
  } catch (e) {
    console.error("Failed to register record hotkey:", e);
  }
}

async function copyToClipboard(image) {
  const fmt = getCopyFormat();
  if (fmt === "base64") {
    clipboard.writeText(`data:image/png;base64,${image.toPNG().toString("base64")}`);
  } else {
    clipboard.writeImage(image);
  }
}

async function convertImage(pngBuffer, fmt) {
  if (fmt === "png") return { buffer: pngBuffer, ext: "png" };
  try {
    const sharp = require("sharp");
    if (fmt === "jpg") {
      const buf = await sharp(pngBuffer).jpeg({ quality: 90 }).toBuffer();
      return { buffer: buf, ext: "jpg" };
    }
    if (fmt === "webp") {
      const buf = await sharp(pngBuffer).webp({ quality: 90 }).toBuffer();
      return { buffer: buf, ext: "webp" };
    }
  } catch (e) {
    console.error("Image conversion failed, falling back to PNG:", e);
  }
  return { buffer: pngBuffer, ext: "png" };
}

let overlayWindow = null;
let tray = null;
let settingsWindow = null;
let overlayReady = false;
let overlayActive = false;
let recordingControlWindow = null;
let isRecording = false;
let toastWindow = null;
let previewWindows = [];
let previewDisplay = null;
let micDropdownWindow = null;
let selectedMicId = "default";
let annotationWindow = null;
let annotationSourcePreview = null;
let updateWindow = null;
let welcomeWindow = null;
let pinnedDataDir;
let pinnedManifestPath;
let isQuitting = false;

// Debounce timers for preview bounds persistence
const boundsDebounceTimers = new Map();
function clearBoundsDebounce(winId) {
  if (boundsDebounceTimers.has(winId)) {
    clearTimeout(boundsDebounceTimers.get(winId));
    boundsDebounceTimers.delete(winId);
  }
}

function loadPinnedManifest() {
  try {
    return JSON.parse(fs.readFileSync(pinnedManifestPath, "utf-8"));
  } catch {
    return [];
  }
}

function savePinnedManifest(manifest) {
  fs.writeFileSync(pinnedManifestPath, JSON.stringify(manifest, null, 2));
}

function persistPin(entry) {
  try {
    // Always store an independent copy in pinnedDataDir so pins survive
    // even if the user deletes the original file from the save folder.
    fs.mkdirSync(pinnedDataDir, { recursive: true });
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const imagePath = path.join(pinnedDataDir, `${id}.png`);
    const image = nativeImage.createFromBuffer(Buffer.from(entry.pngBuffer));
    fs.writeFileSync(imagePath, image.toPNG());

    entry.pinId = imagePath;
    entry.pinnedImagePath = imagePath;

    const manifest = loadPinnedManifest();
    if (!manifest.some((m) => m.imagePath === imagePath)) {
      manifest.push({
        imagePath,
        originalFilePath: entry.filePath,
        bounds: entry.window.getBounds(),
        imgSize: entry.imgSize,
        cardHeight: entry.cardHeight,
        isVideo: entry.isVideo || false,
      });
      savePinnedManifest(manifest);
    }
  } catch (e) {
    console.error("Failed to persist pin:", e);
  }
}

function unpersistPin(entry) {
  if (!entry.pinId) return;

  const manifest = loadPinnedManifest();
  const idx = manifest.findIndex((m) => m.imagePath === entry.pinId);
  if (idx !== -1) {
    manifest.splice(idx, 1);
    savePinnedManifest(manifest);
  }

  // Clean up pinnedDataDir copy (not the user's saved file)
  if (entry.pinnedImagePath && entry.pinnedImagePath !== entry.filePath) {
    try { fs.unlinkSync(entry.pinnedImagePath); } catch {}
  }

  entry.pinId = null;
  entry.pinnedImagePath = null;
}

function updatePinnedBounds(entry) {
  if (!entry.pinId) return;
  const manifest = loadPinnedManifest();
  const item = manifest.find((m) => m.imagePath === entry.pinId);
  if (item) {
    item.bounds = entry.window.getBounds();
    savePinnedManifest(manifest);
  }
}

function restorePinnedPreviews() {
  const manifest = loadPinnedManifest();
  const validEntries = [];

  for (const item of manifest) {
    if (!fs.existsSync(item.imagePath)) continue;

    const pngBuffer = fs.readFileSync(item.imagePath);
    const { bounds, imgSize, cardHeight, originalFilePath, isVideo } = item;

    const win = new BrowserWindow({
      width: bounds.width,
      height: bounds.height,
      x: bounds.x,
      y: bounds.y,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      focusable: true,
      show: false,
      webPreferences: secureWebPrefs("preview-preload.js"),
    });

    win.setAlwaysOnTop(true, "screen-saver");
    win.loadFile("preview.html");

    const imageDataUrl = `data:image/png;base64,${pngBuffer.toString("base64")}`;
    const imgHeight = cardHeight - 2;

    const entry = {
      window: win,
      filePath: originalFilePath,
      cardHeight,
      pinned: true,
      pngBuffer: new Uint8Array(pngBuffer),
      imgSize,
      pinId: item.imagePath,
      pinnedImagePath: item.imagePath,
      isVideo: isVideo || false,
    };
    previewWindows.push(entry);

    win.once("ready-to-show", () => {
      if (!win.isDestroyed()) {
        win.showInactive();
        win.webContents.send("show-preview", {
          imageDataUrl,
          saved: !!originalFilePath,
          hasFile: !!originalFilePath && fs.existsSync(originalFilePath),
          imgHeight,
          pinned: true,
          isVideo: isVideo || false,
        });
      }
    });

    win.on("closed", () => {
      clearBoundsDebounce(win.id);
      const idx = previewWindows.indexOf(entry);
      if (idx !== -1) previewWindows.splice(idx, 1);
      if (!isQuitting) unpersistPin(entry);
      repositionPreviews();
    });

    validEntries.push(item);
  }

  if (validEntries.length !== manifest.length) {
    savePinnedManifest(validEntries);
  }
}

function createOverlay() {
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width, height } = primaryDisplay.size;

  overlayWindow = new BrowserWindow({
    width,
    height,
    x: 0,
    y: 0,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    fullscreenable: false,
    show: false,
    webPreferences: secureWebPrefs("preload.js", { backgroundThrottling: false }),
  });

  overlayWindow.loadFile("overlay.html");
  overlayWindow.setAlwaysOnTop(true, "screen-saver");

  // Prevent the OS or Electron from destroying this long-lived window,
  // but allow it during app quit so the app can actually exit.
  overlayWindow.on("close", (e) => {
    if (!isQuitting) e.preventDefault();
  });

  // Show window once so subsequent activations don't trigger the
  // Windows DWM window-open animation that causes a double-flash.
  overlayWindow.once("ready-to-show", () => {
    overlayWindow.showInactive();
    overlayWindow.setIgnoreMouseEvents(true);
    overlayReady = true;
  });
}

function showOverlay() {
  if (!overlayWindow || overlayWindow.isDestroyed() || !overlayReady) return;

  // Toggle: dismiss if already active
  if (overlayActive) {
    hideOverlay();
    return;
  }

  overlayActive = true;

  const cursorPoint = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursorPoint);

  // Position overlay on the correct display and activate immediately —
  // the renderer grabs a frame from its persistent stream (near-instant)
  const { x, y, width, height } = display.bounds;
  overlayWindow.setBounds({ x, y, width, height });
  overlayWindow.setIgnoreMouseEvents(false);
  overlayWindow.webContents.send("activate-capture", {
    displayId: String(display.id),
  });
  overlayWindow.focus();
}

function hideOverlay() {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  overlayActive = false;
  overlayWindow.webContents.send("overlay-clear");
  overlayWindow.setIgnoreMouseEvents(true);
  overlayWindow.blur();
}

async function handleCaptureData(pngBuffer) {
  const image = nativeImage.createFromBuffer(Buffer.from(pngBuffer));
  copyToClipboard(image);
  let savedPath = null;
  if (getSaveToDisk()) {
    savedPath = await saveToFile(image);
  }
  showPreview(pngBuffer, image.getSize(), savedPath);
}

function showToast(message) {
  if (toastWindow) {
    toastWindow.destroy();
    toastWindow = null;
  }

  const cursorPoint = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursorPoint);

  const w = 260;
  const h = 44;
  const x = display.bounds.x + Math.round(display.bounds.width / 2) - Math.round(w / 2);
  const y = display.bounds.y + display.bounds.height - TOAST_OFFSET_Y;

  toastWindow = new BrowserWindow({
    width: w,
    height: h,
    x,
    y,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    focusable: false,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  toastWindow.setAlwaysOnTop(true, "screen-saver");
  toastWindow.setIgnoreMouseEvents(true);
  const toastFile = message === "saved" ? "toast-saved.html" : "toast.html";
  toastWindow.loadFile(toastFile);

  const thisToast = toastWindow;
  thisToast.once("ready-to-show", () => {
    if (!thisToast.isDestroyed()) thisToast.showInactive();
  });

  setTimeout(() => {
    if (!thisToast.isDestroyed()) {
      thisToast.destroy();
    }
    if (toastWindow === thisToast) toastWindow = null;
  }, TOAST_DURATION_MS);
}

function showWelcome() {
  const settings = loadSettings();
  if (settings.welcomeShown) return;

  const primaryDisplay = screen.getPrimaryDisplay();
  const { width: dw, height: dh } = primaryDisplay.workAreaSize;
  const w = 360;
  const h = 410;
  const x = primaryDisplay.workArea.x + Math.round(dw / 2) - Math.round(w / 2);
  const y = primaryDisplay.workArea.y + Math.round(dh / 2) - Math.round(h / 2);

  welcomeWindow = new BrowserWindow({
    width: w,
    height: h,
    x,
    y,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: false,
    resizable: false,
    movable: true,
    show: false,
    webPreferences: secureWebPrefs("welcome-preload.js"),
  });

  welcomeWindow.setAlwaysOnTop(true, "floating");
  welcomeWindow.loadFile("welcome.html");

  welcomeWindow.once("ready-to-show", () => {
    if (welcomeWindow && !welcomeWindow.isDestroyed()) welcomeWindow.show();
  });

  welcomeWindow.on("closed", () => {
    welcomeWindow = null;
  });
}

async function saveToFile(image) {
  try {
    const folder = getSaveFolder();
    fs.mkdirSync(folder, { recursive: true });

    const fmt = getCopyFormat();
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    let filePath;
    if (fmt === "base64") {
      filePath = path.join(folder, `qgn-${timestamp}.txt`);
      fs.writeFileSync(filePath, `data:image/png;base64,${image.toPNG().toString("base64")}`);
    } else {
      const { buffer, ext } = await convertImage(image.toPNG(), fmt);
      filePath = path.join(folder, `qgn-${timestamp}.${ext}`);
      fs.writeFileSync(filePath, buffer);
    }
    return filePath;
  } catch (e) {
    console.error("Failed to save file:", e);
    return null;
  }
}

function showPreview(pngBuffer, imgSize, filePath, isVideo = false) {
  const rawImgHeight = Math.round(
    (CARD_WIDTH * imgSize.height) / imgSize.width
  );
  const imgHeight = Math.max(PREVIEW_MIN_IMG_H, Math.min(PREVIEW_MAX_IMG_H, rawImgHeight));
  const cardHeight = imgHeight + 2; // border only, overlays are absolute

  const display = screen.getPrimaryDisplay();
  previewDisplay = display.workArea;

  // Stack above existing previews
  let stackOffset = 0;
  for (const p of previewWindows) {
    if (!p.window.isDestroyed()) {
      stackOffset += p.cardHeight + PREVIEW_GAP;
    }
  }

  const x =
    previewDisplay.x + previewDisplay.width - CARD_WIDTH - PREVIEW_MARGIN - SHADOW_PAD;
  const y =
    previewDisplay.y + previewDisplay.height - cardHeight - PREVIEW_MARGIN - stackOffset - SHADOW_PAD;

  const win = new BrowserWindow({
    width: CARD_WIDTH + SHADOW_PAD * 2,
    height: cardHeight + SHADOW_PAD * 2,
    x,
    y,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    focusable: true,
    show: false,
    webPreferences: secureWebPrefs("preview-preload.js"),
  });

  win.setAlwaysOnTop(true, "screen-saver");
  win.loadFile("preview.html");

  const imageDataUrl = `data:image/png;base64,${Buffer.from(pngBuffer).toString("base64")}`;

  const entry = { window: win, filePath, cardHeight, pinned: false, pngBuffer, imgSize, pinId: null, pinnedImagePath: null, isVideo };
  previewWindows.push(entry);

  win.once("ready-to-show", () => {
    if (!win.isDestroyed()) {
      win.showInactive();
      win.webContents.send("show-preview", {
        imageDataUrl,
        saved: !!filePath,
        hasFile: !!filePath,
        imgHeight,
        isVideo,
      });
    }
  });

  win.on("closed", () => {
    clearBoundsDebounce(win.id);
    const idx = previewWindows.indexOf(entry);
    if (idx !== -1) previewWindows.splice(idx, 1);
    if (!isQuitting) unpersistPin(entry);
    repositionPreviews();
  });
}

function repositionPreviews() {
  if (!previewDisplay) return;

  let stackOffset = 0;
  for (const p of previewWindows) {
    if (p.window.isDestroyed() || p.pinned) continue;
    const x = previewDisplay.x + previewDisplay.width - CARD_WIDTH - PREVIEW_MARGIN - SHADOW_PAD;
    const y =
      previewDisplay.y +
      previewDisplay.height -
      p.cardHeight -
      PREVIEW_MARGIN -
      stackOffset -
      SHADOW_PAD;
    p.window.setBounds({ x, y, width: CARD_WIDTH + SHADOW_PAD * 2, height: p.cardHeight + SHADOW_PAD * 2 });
    stackOffset += p.cardHeight + PREVIEW_GAP;
  }
}

function openAnnotationEditor(previewEntry) {
  if (annotationWindow && !annotationWindow.isDestroyed()) {
    annotationWindow.focus();
    return;
  }

  const { imgSize } = previewEntry;
  const display = screen.getPrimaryDisplay();
  const workArea = display.workArea;

  const maxW = Math.round(workArea.width * ANNOTATION_AREA_FRACTION);
  const maxH = Math.round(workArea.height * ANNOTATION_AREA_FRACTION);
  const scale = Math.min(1, (maxW - ANNOTATION_PAD) / imgSize.width, (maxH - ANNOTATION_TOOLBAR_H - ANNOTATION_PAD) / imgSize.height);

  const winW = Math.max(MIN_ANNOTATION_W, Math.round(imgSize.width * scale) + ANNOTATION_PAD);
  const winH = Math.max(MIN_ANNOTATION_H, Math.round(imgSize.height * scale) + ANNOTATION_TOOLBAR_H + ANNOTATION_PAD);

  const x = workArea.x + Math.round((workArea.width - winW) / 2);
  const y = workArea.y + Math.round((workArea.height - winH) / 2);

  annotationWindow = new BrowserWindow({
    width: winW,
    height: winH,
    x,
    y,
    frame: false,
    transparent: false,
    backgroundColor: "#1a1a1a",
    resizable: false,
    skipTaskbar: false,
    alwaysOnTop: true,
    show: false,
    webPreferences: secureWebPrefs("annotation-preload.js"),
  });

  annotationWindow.setAlwaysOnTop(true, "screen-saver");
  annotationWindow.loadFile("annotation.html");
  annotationSourcePreview = previewEntry;

  const imageDataUrl = `data:image/png;base64,${Buffer.from(previewEntry.pngBuffer).toString("base64")}`;

  annotationWindow.once("ready-to-show", () => {
    if (!annotationWindow.isDestroyed()) {
      annotationWindow.show();
      annotationWindow.webContents.send("load-image", { imageDataUrl });
    }
  });

  annotationWindow.on("closed", () => {
    annotationWindow = null;
    annotationSourcePreview = null;
  });
}

let videoSourceId = null;
let videoScaleFactor = 1;

async function showOverlayForVideo() {
  if (!overlayWindow || overlayWindow.isDestroyed() || !overlayReady) return;

  // If already recording, stop the recording
  if (isRecording) {
    if (recordingControlWindow) {
      recordingControlWindow.webContents.send("stop-recording");
    }
    return;
  }

  // Toggle: dismiss if already active
  if (overlayActive) {
    dismissVideoSetup();
    return;
  }

  overlayActive = true;

  const cursorPoint = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursorPoint);
  videoScaleFactor = display.scaleFactor;

  // Get source ID up front so it's ready when user finishes selecting
  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: { width: 1, height: 1 },
  });

  if (!overlayActive) return;

  const source =
    sources.find((s) => s.display_id === String(display.id)) || sources[0];
  if (!source) {
    overlayActive = false;
    return;
  }
  videoSourceId = source.id;

  // Show overlay for area selection
  const { x, y, width, height } = display.bounds;
  overlayWindow.setBounds({ x, y, width, height });
  overlayWindow.setIgnoreMouseEvents(false);
  overlayWindow.webContents.send("overlay-reset-video");
  overlayWindow.focus();

  // Show control bar in setup mode (audio toggles only) alongside the overlay
  recordingControlWindow = new BrowserWindow({
    width: 230,
    height: 48,
    x: display.bounds.x + Math.round(display.bounds.width / 2) - 115,
    y: display.bounds.y + 20,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    focusable: true,
    show: false,
    webPreferences: secureWebPrefs("record-preload.js", { backgroundThrottling: false }),
  });

  recordingControlWindow.loadFile("record-control.html", {
    search: `format=${getRecordFormat()}`,
  });
  recordingControlWindow.setAlwaysOnTop(true, "screen-saver");
  recordingControlWindow.setContentProtection(true);

  // Show without stealing focus from the overlay, so Escape works immediately
  recordingControlWindow.once("ready-to-show", () => {
    if (recordingControlWindow && !recordingControlWindow.isDestroyed()) {
      recordingControlWindow.showInactive();
    }
  });

  recordingControlWindow.on("closed", () => {
    recordingControlWindow = null;
    if (micDropdownWindow && !micDropdownWindow.isDestroyed()) {
      micDropdownWindow.destroy();
      micDropdownWindow = null;
    }
    if (isRecording) {
      isRecording = false;
      if (overlayWindow && !overlayWindow.isDestroyed()) {
        overlayWindow.webContents.send("overlay-hide-rec-border");
        overlayWindow.setContentProtection(false);
      }
    }
  });

  // Pre-create dropdown window (hidden) so it opens instantly
  // Position off-screen initially; repositioned in open-mic-dropdown handler
  const dropW = 260;
  const dropH = 200;

  micDropdownWindow = new BrowserWindow({
    width: dropW,
    height: dropH,
    x: -1000,
    y: -1000,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    focusable: true,
    show: false,
    webPreferences: secureWebPrefs("dropdown-preload.js", { backgroundThrottling: false }),
  });

  micDropdownWindow.loadFile("device-dropdown.html");
  micDropdownWindow.setAlwaysOnTop(true, "screen-saver");
}

function dismissVideoSetup() {
  hideOverlay();
  videoSourceId = null;
  if (recordingControlWindow && !isRecording) {
    recordingControlWindow.close();
    recordingControlWindow = null;
  }
}

function beginVideoRecording(region) {
  if (!videoSourceId || !recordingControlWindow) return;

  isRecording = true;

  // Show recording border on overlay
  overlayActive = false;
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.setIgnoreMouseEvents(true);
    overlayWindow.setContentProtection(true);
    overlayWindow.webContents.send("overlay-show-rec-border", region);
  }

  // Resize control window for recording phase and tell it to start
  recordingControlWindow.setBounds({
    ...recordingControlWindow.getBounds(),
    width: 230,
  });

  recordingControlWindow.webContents.send("start-recording", {
    sourceId: videoSourceId,
    recordFormat: getRecordFormat(),
    region: {
      x: Math.round(region.x * videoScaleFactor),
      y: Math.round(region.y * videoScaleFactor),
      width: Math.round(region.width * videoScaleFactor),
      height: Math.round(region.height * videoScaleFactor),
    },
  });

  videoSourceId = null;
}

function stopRecordingUI() {
  // Hide the recording border and restore overlay state
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send("overlay-hide-rec-border");
    overlayWindow.setContentProtection(false);
  }

  if (recordingControlWindow) {
    recordingControlWindow.close();
    recordingControlWindow = null;
  }
  isRecording = false;
}

function saveRecording(data, thumbnailDataUrl, format) {
  try {
    const folder = getSaveFolder();
    fs.mkdirSync(folder, { recursive: true });

    const ext = format === "mp4" || format === "gif" ? format : "webm";
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filePath = path.join(folder, `qgn-${timestamp}.${ext}`);
    fs.writeFileSync(filePath, Buffer.from(data));

    stopRecordingUI();

    if (thumbnailDataUrl) {
      const base64 = thumbnailDataUrl.replace(/^data:image\/png;base64,/, "");
      const pngBuffer = Buffer.from(base64, "base64");
      const image = nativeImage.createFromBuffer(pngBuffer);
      const imgSize = image.getSize();
      showPreview(new Uint8Array(pngBuffer), imgSize, filePath, true);
    } else {
      showToast("saved");
    }
  } catch (e) {
    console.error("Failed to save recording:", e);
    stopRecordingUI();
  }
}

async function chooseSaveFolder() {
  const result = await dialog.showOpenDialog({
    title: "Choose screenshot save folder",
    defaultPath: getSaveFolder(),
    properties: ["openDirectory"],
  });

  if (!result.canceled && result.filePaths.length > 0) {
    saveSetting("saveFolder", result.filePaths[0]);
    rebuildTrayMenu();
  }
}

function rebuildTrayMenu() {
  const hk = getHotkeys();
  const contextMenu = Menu.buildFromTemplate([
    { label: `Capture (${hotkeyToLabel(hk.capture)})`, click: showOverlay },
    { label: `Record (${hotkeyToLabel(hk.record)})`, click: showOverlayForVideo },
    { type: "separator" },
    { label: "Settings...", click: toggleSettingsWindow },
    { type: "separator" },
    { label: "Quit", click: () => app.quit() },
  ]);

  tray.setContextMenu(contextMenu);
}

function toggleSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.close();
    return;
  }

  const trayBounds = tray.getBounds();
  const winW = 260;
  const winH = 450;

  // Position above the tray icon (Windows taskbar is typically at the bottom)
  const x = Math.round(trayBounds.x + trayBounds.width / 2 - winW / 2);
  const y = Math.round(trayBounds.y - winH - 4);

  settingsWindow = new BrowserWindow({
    width: winW,
    height: winH,
    x,
    y,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    show: false,
    webPreferences: secureWebPrefs("settings-preload.js", { backgroundThrottling: false }),
  });

  settingsWindow.loadFile("settings.html");
  settingsWindow.setAlwaysOnTop(true, "screen-saver");

  settingsWindow.once("ready-to-show", () => {
    settingsWindow.show();
  });

  settingsWindow.on("blur", () => {
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.close();
    }
  });

  settingsWindow.on("closed", () => {
    settingsWindow = null;
  });
}

function createTray() {
  const trayIcon = nativeImage.createFromPath(
    path.join(__dirname, "icons", "tray.png")
  );
  tray = new Tray(trayIcon);
  const hk = getHotkeys();
  tray.setToolTip(`qgn — ${hotkeyToLabel(hk.capture)} capture, ${hotkeyToLabel(hk.record)} record`);
  rebuildTrayMenu();
}

function showUpdateToast() {
  if (updateWindow && !updateWindow.isDestroyed()) {
    updateWindow.destroy();
  }

  const display = screen.getPrimaryDisplay();
  const w = 320;
  const h = 300;
  const x = display.workArea.x + Math.round(display.workArea.width / 2) - Math.round(w / 2);
  const y = display.workArea.y + Math.round(display.workArea.height / 2) - Math.round(h / 2);

  updateWindow = new BrowserWindow({
    width: w,
    height: h,
    x,
    y,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: true,
    focusable: true,
    show: false,
    webPreferences: secureWebPrefs("update-preload.js"),
  });

  updateWindow.setAlwaysOnTop(true, "screen-saver");
  updateWindow.loadFile("toast-update.html");

  updateWindow.once("ready-to-show", () => {
    if (updateWindow && !updateWindow.isDestroyed()) {
      updateWindow.show();
    }
  });

  updateWindow.on("closed", () => {
    updateWindow = null;
  });
}

function setupAutoUpdater() {
  getAutoUpdater().autoDownload = true;
  getAutoUpdater().autoInstallOnAppQuit = true;
  getAutoUpdater().logger = console;

  // Buffer the latest status so it can be replayed after the window loads,
  // handling the race where download-progress fires before did-finish-load.
  let pendingStatus = null;
  let downloadStallTimer = null;

  function sendUpdateStatus(data) {
    pendingStatus = data;
    if (updateWindow && !updateWindow.isDestroyed()) {
      updateWindow.webContents.send("update-status", data);
    }
  }

  function onUpdateWindowReady() {
    if (pendingStatus && updateWindow && !updateWindow.isDestroyed()) {
      updateWindow.webContents.send("update-status", pendingStatus);
    }
  }

  getAutoUpdater().on("update-available", () => {
    pendingStatus = { status: "downloading", percent: 0 };
    showUpdateToast();
    if (updateWindow && !updateWindow.isDestroyed()) {
      updateWindow.webContents.once("did-finish-load", onUpdateWindowReady);
    }
    // Show an error if the download hasn't progressed within 60 seconds
    downloadStallTimer = setTimeout(() => {
      if (pendingStatus && pendingStatus.status === "downloading" && pendingStatus.percent < 1) {
        sendUpdateStatus({ status: "error", message: "Download timed out. Check your connection and try again." });
      }
    }, 60000);
  });

  getAutoUpdater().on("download-progress", (progress) => {
    sendUpdateStatus({ status: "downloading", percent: progress.percent });
  });

  getAutoUpdater().on("update-downloaded", () => {
    if (downloadStallTimer) {
      clearTimeout(downloadStallTimer);
      downloadStallTimer = null;
    }
    if (updateWindow && !updateWindow.isDestroyed()) {
      sendUpdateStatus({ status: "ready" });
    } else {
      pendingStatus = { status: "ready" };
      showUpdateToast();
      if (updateWindow && !updateWindow.isDestroyed()) {
        updateWindow.webContents.once("did-finish-load", onUpdateWindowReady);
      }
    }
  });

  getAutoUpdater().on("error", (err) => {
    console.error("Auto-update error:", err);
    if (downloadStallTimer) {
      clearTimeout(downloadStallTimer);
      downloadStallTimer = null;
    }
    sendUpdateStatus({ status: "error", message: err?.message || "Update failed" });
  });

  // Check for updates now and every 4 hours
  getAutoUpdater().checkForUpdates().catch(() => {});
  setInterval(() => {
    getAutoUpdater().checkForUpdates().catch(() => {});
  }, 4 * 60 * 60 * 1000);
}

async function cliCapture() {
  try {
    // Use primary display for fullscreen capture
    const primary = screen.getPrimaryDisplay();
    const { width, height } = primary.size;
    const scaleFactor = primary.scaleFactor || 1;
    const thumbW = Math.round(width * scaleFactor);
    const thumbH = Math.round(height * scaleFactor);

    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width: thumbW, height: thumbH },
    });

    // Match primary display
    const source =
      sources.find((s) => s.display_id === String(primary.id)) || sources[0];

    if (!source) {
      process.stderr.write("Error: no screen source found\n");
      app.exit(1);
      return;
    }

    const image = source.thumbnail;
    if (image.isEmpty()) {
      process.stderr.write("Error: captured empty image\n");
      app.exit(1);
      return;
    }

    copyToClipboard(image);

    const savedPath = await saveToFile(image);
    if (savedPath) {
      process.stdout.write(savedPath + "\n");
    } else {
      process.stdout.write("Copied to clipboard (save to disk disabled or failed)\n");
    }
    app.exit(0);
  } catch (e) {
    process.stderr.write("Error: " + e.message + "\n");
    app.exit(1);
  }
}

app.whenReady().then(() => {
  if (cliMode) {
    cliCapture();
    return;
  }

  app.setLoginItemSettings({ openAtLogin: getStartOnStartup() });

  pinnedDataDir = path.join(app.getPath("userData"), "pinned");
  pinnedManifestPath = path.join(app.getPath("userData"), "pinned-previews.json");

  createOverlay();
  createTray();
  restorePinnedPreviews();

  // Keep previewDisplay up-to-date when monitors change
  screen.on("display-metrics-changed", () => {
    previewDisplay = screen.getPrimaryDisplay().workArea;
    repositionPreviews();
  });
  screen.on("display-added", () => {
    previewDisplay = screen.getPrimaryDisplay().workArea;
  });
  screen.on("display-removed", () => {
    previewDisplay = screen.getPrimaryDisplay().workArea;
    repositionPreviews();
  });

  registerHotkeys();
  setupAutoUpdater();
  showWelcome();

  ipcMain.on("welcome-close", () => {
    saveSetting("welcomeShown", true);
    if (welcomeWindow && !welcomeWindow.isDestroyed()) {
      welcomeWindow.destroy();
      welcomeWindow = null;
    }
  });

  ipcMain.handle("get-welcome-hotkeys", () => {
    const hk = getHotkeys();
    return {
      capture: hotkeyToLabel(hk.capture),
      record: hotkeyToLabel(hk.record),
    };
  });

  ipcMain.on("welcome-open-settings", () => {
    toggleSettingsWindow();
  });

  ipcMain.on("update-install", () => {
    getAutoUpdater().quitAndInstall(false, true);
  });

  ipcMain.on("update-dismiss", () => {
    if (updateWindow && !updateWindow.isDestroyed()) {
      updateWindow.destroy();
      updateWindow = null;
    }
  });

  ipcMain.handle("get-sources", async () => {
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width: 1, height: 1 },
    });
    return sources.map((s) => ({ id: s.id, displayId: s.display_id }));
  });

  ipcMain.on("capture", (_event, pngBuffer) => {
    hideOverlay();
    handleCaptureData(pngBuffer);
  });

  ipcMain.on("close-mic-dropdown", () => {
    if (micDropdownWindow && !micDropdownWindow.isDestroyed()) {
      micDropdownWindow.hide();
    }
  });

  ipcMain.on("start-video-recording", (_event, region) => {
    if (micDropdownWindow && !micDropdownWindow.isDestroyed()) {
      micDropdownWindow.hide();
    }
    beginVideoRecording(region);
  });

  ipcMain.on("save-recording", (_event, data, thumbnail, format) => {
    saveRecording(data, thumbnail, format);
  });

  ipcMain.on("open-mic-dropdown", () => {
    if (!micDropdownWindow || micDropdownWindow.isDestroyed()) return;

    if (micDropdownWindow.isVisible()) {
      micDropdownWindow.hide();
      return;
    }

    // Reposition relative to control bar and show
    if (recordingControlWindow && !recordingControlWindow.isDestroyed()) {
      const bounds = recordingControlWindow.getBounds();
      micDropdownWindow.setBounds({
        x: bounds.x + bounds.width - 260,
        y: bounds.y + bounds.height + 4,
        width: 260,
        height: 200,
      });
    }

    micDropdownWindow.webContents.send("refresh-devices");
    micDropdownWindow.showInactive();
  });

  ipcMain.handle("get-selected-mic-id", () => selectedMicId);

  ipcMain.on("mic-device-selected", (_event, deviceId) => {
    selectedMicId = deviceId;
    if (recordingControlWindow && !recordingControlWindow.isDestroyed()) {
      recordingControlWindow.webContents.send("mic-device-selected", deviceId);
    }
    if (micDropdownWindow && !micDropdownWindow.isDestroyed()) {
      micDropdownWindow.hide();
    }
  });

  ipcMain.on("close-preview", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && !win.isDestroyed()) {
      win.destroy();
    }
  });

  ipcMain.on("preview-pin", (event, pinned) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const entry = previewWindows.find((p) => p.window === win);
    if (entry) {
      entry.pinned = pinned;
      if (pinned) {
        persistPin(entry);
      } else {
        unpersistPin(entry);
      }
      repositionPreviews();
    }
  });

  ipcMain.handle("preview-get-bounds", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    return win && !win.isDestroyed() ? win.getBounds() : null;
  });

  ipcMain.on("preview-set-bounds", (event, bounds) => {
    const { x, y, width, height } = bounds || {};
    if (typeof x !== "number" || typeof y !== "number" ||
        typeof width !== "number" || typeof height !== "number") return;
    if (width < 50 || height < 50) return;
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && !win.isDestroyed()) {
      win.setBounds(bounds);
      const entry = previewWindows.find((p) => p.window === win);
      if (entry && entry.pinned) {
        const id = win.id;
        if (boundsDebounceTimers.has(id)) clearTimeout(boundsDebounceTimers.get(id));
        boundsDebounceTimers.set(id, setTimeout(() => {
          boundsDebounceTimers.delete(id);
          updatePinnedBounds(entry);
        }, BOUNDS_DEBOUNCE_MS));
      }
    }
  });

  ipcMain.on("preview-open-file", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const entry = previewWindows.find((p) => p.window === win);
    if (entry && entry.filePath) {
      shell.showItemInFolder(entry.filePath);
    }
  });


  ipcMain.on("preview-edit", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const entry = previewWindows.find((p) => p.window === win);
    if (entry) openAnnotationEditor(entry);
  });

  ipcMain.on("annotation-save", (event, pngBuffer) => {
    const image = nativeImage.createFromBuffer(Buffer.from(pngBuffer));
    copyToClipboard(image);

    if (annotationSourcePreview) {
      try {
        if (annotationSourcePreview.filePath && !annotationSourcePreview.isVideo) {
          const tmp = annotationSourcePreview.filePath + ".tmp";
          fs.writeFileSync(tmp, image.toPNG());
          fs.renameSync(tmp, annotationSourcePreview.filePath);
        }
      } catch (e) {
        console.error("Failed to write annotated file:", e);
      }
      annotationSourcePreview.pngBuffer = pngBuffer;

      // Update persisted pinned image if stored in pinnedDataDir
      if (annotationSourcePreview.pinnedImagePath && annotationSourcePreview.pinnedImagePath !== annotationSourcePreview.filePath) {
        try {
          fs.writeFileSync(annotationSourcePreview.pinnedImagePath, image.toPNG());
        } catch (e) {
          console.error("Failed to write pinned image:", e);
        }
      }

      if (annotationSourcePreview.window && !annotationSourcePreview.window.isDestroyed()) {
        const imageDataUrl = `data:image/png;base64,${Buffer.from(pngBuffer).toString("base64")}`;
        annotationSourcePreview.window.webContents.send("update-preview", { imageDataUrl });
      }
    }

    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && !win.isDestroyed()) win.destroy();
  });

  ipcMain.on("annotation-cancel", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && !win.isDestroyed()) win.destroy();
  });

  ipcMain.handle("get-settings", () => {
    const hk = getHotkeys();
    return {
      copyFormat: getCopyFormat(),
      recordFormat: getRecordFormat(),
      saveToDisk: getSaveToDisk(),
      saveFolder: getSaveFolder(),
      hotkeys: hk,
      startOnStartup: getStartOnStartup(),
    };
  });

  function sendSettingsUpdate() {
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.webContents.send("settings-updated", {
        copyFormat: getCopyFormat(),
        recordFormat: getRecordFormat(),
        saveToDisk: getSaveToDisk(),
        saveFolder: getSaveFolder(),
        hotkeys: getHotkeys(),
        startOnStartup: getStartOnStartup(),
      });
    }
  }

  ipcMain.on("set-copy-format", (_event, fmt) => {
    const VALID_FORMATS = ["png", "jpg", "webp", "base64"];
    if (!VALID_FORMATS.includes(fmt)) return;
    saveSetting("copyFormat", fmt);
    rebuildTrayMenu();
    sendSettingsUpdate();
  });

  ipcMain.on("set-record-format", (_event, fmt) => {
    const VALID_FORMATS = ["mp4", "gif"];
    if (!VALID_FORMATS.includes(fmt)) return;
    saveSetting("recordFormat", fmt);
    sendSettingsUpdate();
  });

  ipcMain.on("set-save-to-disk", (_event, value) => {
    saveSetting("saveToDisk", value);
    rebuildTrayMenu();
    sendSettingsUpdate();
  });

  ipcMain.on("set-start-on-startup", (_event, value) => {
    saveSetting("startOnStartup", value);
    app.setLoginItemSettings({ openAtLogin: value });
    sendSettingsUpdate();
  });

  ipcMain.on("set-hotkey", (_event, { action, accelerator }) => {
    // Validate action and accelerator before registering
    if (!["capture", "record"].includes(action)) return;
    if (typeof accelerator !== "string" || accelerator.length > 100) return;
    // Validate the accelerator by attempting to register it first
    try {
      globalShortcut.register(accelerator, () => {});
      globalShortcut.unregister(accelerator);
    } catch (e) {
      console.error("Invalid accelerator:", accelerator, e);
      return;
    }
    saveSetting(`hotkey_${action}`, accelerator);
    registerHotkeys();
    rebuildTrayMenu();
    const hk = getHotkeys();
    tray.setToolTip(`qgn — ${hotkeyToLabel(hk.capture)} capture, ${hotkeyToLabel(hk.record)} record`);
    sendSettingsUpdate();
  });

  ipcMain.on("choose-save-folder", async () => {
    // Temporarily remove blur-to-close so the file dialog doesn't dismiss us
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.removeAllListeners("blur");
    }
    const result = await dialog.showOpenDialog({
      title: "Choose screenshot save folder",
      defaultPath: getSaveFolder(),
      properties: ["openDirectory"],
    });
    if (!result.canceled && result.filePaths.length > 0) {
      saveSetting("saveFolder", result.filePaths[0]);
      rebuildTrayMenu();
    }
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      sendSettingsUpdate();
      // Re-attach blur-to-close
      settingsWindow.on("blur", () => {
        if (settingsWindow && !settingsWindow.isDestroyed()) {
          settingsWindow.close();
        }
      });
      settingsWindow.focus();
    }
  });

  ipcMain.on("cancel", () => {
    hideOverlay();
    if (micDropdownWindow && !micDropdownWindow.isDestroyed()) {
      micDropdownWindow.hide();
    }
    if (isRecording) {
      stopRecordingUI();
    } else if (recordingControlWindow) {
      recordingControlWindow.close();
      recordingControlWindow = null;
    }
    videoSourceId = null;
  });
});

app.on("before-quit", () => {
  isQuitting = true;  // module-level flag
  // Save final bounds for pinned previews (covers drag-to-move which bypasses set-bounds)
  try {
    const manifest = loadPinnedManifest();
    let changed = false;
    for (const entry of previewWindows) {
      if (!entry.pinned || !entry.pinId || entry.window.isDestroyed()) continue;
      const item = manifest.find((m) => m.imagePath === entry.pinId);
      if (item) {
        item.bounds = entry.window.getBounds();
        changed = true;
      }
    }
    if (changed) savePinnedManifest(manifest);
  } catch {}
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
});

app.on("window-all-closed", () => {});
