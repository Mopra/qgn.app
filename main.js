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
const { assembleAnimation } = require("./lib/animation.js");
const { sanitizeStudioColors, sanitizeStudioGradients, DEFAULT_STUDIO_COLORS } = require("./lib/palette.js");
const { STUDIO_VIDEO_EXTS, fileExt, videoMimeForPath, canOpenInStudio } = require("./lib/media.js");
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
// Markup-mode Studio windows open sized to the image, the way the old
// annotation editor did. Compose and clip windows open as a full workspace.
const MARKUP_AREA_FRACTION = 0.85;
const MARKUP_PAD = 80;
const MARKUP_CHROME_H = 94; // top bar + tool rail
const MIN_MARKUP_W = 720;
const MIN_MARKUP_H = 420;
const PREVIEW_MIN_IMG_H = 80;
const PREVIEW_MAX_IMG_H = 200;
const BOUNDS_DEBOUNCE_MS = 200;
// Show the one-time "star us on GitHub" prompt once the user has clearly
// found the app useful (i.e. after this many completed captures).
const STAR_PROMPT_CAPTURE_THRESHOLD = 10;
const REPO_URL = "https://github.com/Mopra/qgn.app";

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

// ── Single-instance lock ──
// Enforce one running GUI instance. The CLI `capture` command is intentionally
// allowed to run as its own short-lived process, so it bypasses the lock.
let hasInstanceLock = true;
if (!cliMode) {
  hasInstanceLock = app.requestSingleInstanceLock();
  if (!hasInstanceLock) {
    app.quit();
  } else {
    // A second launch (e.g. clicking the shortcut while already in the tray)
    // triggers a capture on the existing instance instead of starting a new one.
    app.on("second-instance", () => {
      if (overlayReady) showOverlay();
    });
  }
}

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

// JPG/WebP encode quality (1–100). Default 90.
function getImageQuality() {
  const q = loadSettings().imageQuality;
  return Number.isFinite(q) && q >= 1 && q <= 100 ? q : 90;
}

// Seconds before an unpinned preview auto-dismisses. 0 = never. Default 10.
function getDismissSeconds() {
  const v = loadSettings().dismissSeconds;
  return Number.isFinite(v) && v >= 0 ? v : 10;
}

// Seconds of 3-2-1 countdown before recording begins. 0 = off. Default 3.
function getRecordCountdown() {
  const v = loadSettings().recordCountdown;
  return Number.isFinite(v) && v >= 0 ? v : 3;
}

function getStudioColors() {
  const cleaned = sanitizeStudioColors(loadSettings().studioColors);
  // Distinguish "no palette saved yet" (use defaults) from "saved empty palette".
  return cleaned === null ? DEFAULT_STUDIO_COLORS.slice() : cleaned;
}

function getStudioGradients() {
  const cleaned = sanitizeStudioGradients(loadSettings().studioGradients);
  return cleaned === null ? [] : cleaned;
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
    .replace("Command", "Ctrl");
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

function copyToClipboard(image) {
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
    const quality = getImageQuality();
    if (fmt === "jpg") {
      const buf = await sharp(pngBuffer).jpeg({ quality }).toBuffer();
      return { buffer: buf, ext: "jpg" };
    }
    if (fmt === "webp") {
      const buf = await sharp(pngBuffer).webp({ quality }).toBuffer();
      return { buffer: buf, ext: "webp" };
    }
  } catch (e) {
    console.error("Image conversion failed, falling back to PNG:", e);
  }
  return { buffer: pngBuffer, ext: "png" };
}

// Re-encode a nativeImage to a path, matching the format implied by its
// extension (so annotating a .jpg/.webp/.txt file doesn't silently write PNG
// bytes under the wrong extension). Writes atomically via a temp file.
async function writeImageToPath(image, filePath) {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  const tmp = filePath + ".tmp";
  if (ext === "txt") {
    fs.writeFileSync(tmp, `data:image/png;base64,${image.toPNG().toString("base64")}`);
  } else if (ext === "jpg" || ext === "jpeg") {
    const { buffer } = await convertImage(image.toPNG(), "jpg");
    fs.writeFileSync(tmp, buffer);
  } else if (ext === "webp") {
    const { buffer } = await convertImage(image.toPNG(), "webp");
    fs.writeFileSync(tmp, buffer);
  } else {
    fs.writeFileSync(tmp, image.toPNG());
  }
  fs.renameSync(tmp, filePath);
}

let overlayWindow = null;
let tray = null;
let settingsWindow = null;
let overlayReady = false;
let overlayActive = false;
// Cursor-free capture of the active display, taken when the screenshot overlay
// activates so it's ready by the time the user finishes selecting a region.
let pendingScreenshot = null;
let recordingControlWindow = null;
let isRecording = false;
let toastWindow = null;
let previewWindows = [];
let previewDisplay = null;
let micDropdownWindow = null;
let selectedMicId = "default";
// Every Studio window, keyed by BrowserWindow, with the capture it came from
// and the mode it was opened in. Studio is no longer a singleton: annotating a
// screenshot and framing a clip at the same time is a normal thing to do.
const studioWindows = new Map();
let updateWindow = null;
let welcomeWindow = null;
let starWindow = null;
let pinnedDataDir;
let pinnedManifestPath;
let isQuitting = false;
// Temp PNGs materialized for drag-out when save-to-disk is off. Removed on
// quit so they don't pile up in the user's temp folder forever.
const dragTempFiles = new Set();

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

// Written atomically: a crash mid-write would otherwise leave a truncated
// manifest, which reads back as "no pins" and silently loses every pinned card.
function savePinnedManifest(manifest) {
  const tmp = pinnedManifestPath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2));
  fs.renameSync(tmp, pinnedManifestPath);
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
          canStudio: canOpenInStudio(entry),
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

  // Toggle: dismiss if already active. A video setup owns extra windows (the
  // control bar and its mic dropdown), so it has to be torn down through
  // dismissVideoSetup or those would be left stranded on screen.
  if (overlayActive) {
    if (recordingControlWindow || videoSourceId) dismissVideoSetup();
    else hideOverlay();
    return;
  }

  overlayActive = true;

  const cursorPoint = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursorPoint);

  // Exclude the overlay (and its dimming UI) from screen capture so it can
  // never bleed into the screenshot, then grab a cursor-free frame of the
  // display up front. desktopCapturer thumbnails omit the OS cursor — unlike a
  // live getUserMedia stream — so the cursor is no longer baked into captures.
  overlayWindow.setContentProtection(true);
  startScreenshotCapture(display);

  // Position overlay on the correct display and activate immediately.
  const { x, y, width, height } = display.bounds;
  overlayWindow.setBounds({ x, y, width, height });
  overlayWindow.setIgnoreMouseEvents(false);
  overlayWindow.webContents.send("activate-capture", {
    displayId: String(display.id),
  });
  overlayWindow.focus();
}

// Capture the given display now, cursor-free, at native resolution. The
// resulting nativeImage is cropped to the user's selection once they release.
function startScreenshotCapture(display) {
  const sf = display.scaleFactor || 1;
  pendingScreenshot = desktopCapturer
    .getSources({
      types: ["screen"],
      thumbnailSize: {
        width: Math.round(display.size.width * sf),
        height: Math.round(display.size.height * sf),
      },
    })
    .then((sources) => {
      const source =
        sources.find((s) => s.display_id === String(display.id)) || sources[0];
      return source ? source.thumbnail : null;
    })
    .catch((e) => {
      console.error("Screenshot capture failed:", e);
      return null;
    });
}

function hideOverlay() {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  overlayActive = false;
  pendingScreenshot = null;
  overlayWindow.webContents.send("overlay-clear");
  overlayWindow.setIgnoreMouseEvents(true);
  overlayWindow.setContentProtection(false);
  overlayWindow.blur();
}

async function handleCaptureData(pngBuffer) {
  const image = nativeImage.createFromBuffer(Buffer.from(pngBuffer));
  copyToClipboard(image);
  let savedPath = null;
  if (getSaveToDisk()) {
    savedPath = await saveToFile(image);
    if (!savedPath) showErrorToast("Couldn't save to disk — copied to clipboard only");
  }
  showPreview(pngBuffer, image.getSize(), savedPath);
  recordCaptureForStarPrompt();
}

// Capture the whole display under the cursor (cursor-free), no region select.
async function captureFullScreen() {
  try {
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const sf = display.scaleFactor || 1;
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: {
        width: Math.round(display.size.width * sf),
        height: Math.round(display.size.height * sf),
      },
    });
    const source =
      sources.find((s) => s.display_id === String(display.id)) || sources[0];
    if (!source || source.thumbnail.isEmpty()) {
      showErrorToast("Couldn't capture the screen");
      return;
    }
    handleCaptureData(source.thumbnail.toPNG());
  } catch (e) {
    console.error("Full-screen capture failed:", e);
    showErrorToast("Couldn't capture the screen");
  }
}

// Open Studio on whatever image is currently on the clipboard, in either
// markup or compose mode.
function studioClipboard(mode) {
  const image = clipboard.readImage();
  if (image.isEmpty()) {
    showErrorToast("No image on the clipboard to open in Studio");
    return;
  }
  const png = image.toPNG();
  openStudio({
    pngBuffer: new Uint8Array(png),
    imgSize: image.getSize(),
    window: null,
    filePath: null,
    isVideo: false,
    pinnedImagePath: null,
    fromClipboard: true,
  }, { mode });
}

// kind: "saved" | "copied" | "error" | other (generic). For errors, `message`
// is shown to the user via the toast's location hash.
function showToast(kind, message) {
  if (toastWindow) {
    toastWindow.destroy();
    toastWindow = null;
  }

  const cursorPoint = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursorPoint);

  const isError = kind === "error";
  const w = isError ? 340 : 260;
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

  let toastFile = "toast.html";
  if (kind === "saved") toastFile = "toast-saved.html";
  else if (kind === "copied") toastFile = "toast-copied.html";
  else if (kind === "error") toastFile = "toast-error.html";

  const loadOpts = isError && message ? { hash: encodeURIComponent(message) } : undefined;
  toastWindow.loadFile(toastFile, loadOpts);

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

function showErrorToast(message) {
  showToast("error", message);
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

function showStarPrompt() {
  if (starWindow && !starWindow.isDestroyed()) return;

  // Mark it shown up front so it never appears more than once, even if the
  // user quits without interacting with it.
  saveSetting("starPromptShown", true);

  const primaryDisplay = screen.getPrimaryDisplay();
  const { width: dw, height: dh } = primaryDisplay.workAreaSize;
  const w = 360;
  const h = 320;
  const x = primaryDisplay.workArea.x + Math.round(dw / 2) - Math.round(w / 2);
  const y = primaryDisplay.workArea.y + Math.round(dh / 2) - Math.round(h / 2);

  starWindow = new BrowserWindow({
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
    webPreferences: secureWebPrefs("star-preload.js"),
  });

  starWindow.setAlwaysOnTop(true, "floating");
  starWindow.loadFile("star.html");

  starWindow.once("ready-to-show", () => {
    if (starWindow && !starWindow.isDestroyed()) starWindow.show();
  });

  starWindow.on("closed", () => {
    starWindow = null;
  });
}

function closeStarPrompt() {
  if (starWindow && !starWindow.isDestroyed()) {
    starWindow.destroy();
  }
  starWindow = null;
}

// Count completed captures and, once the user has clearly found the app
// useful, show a one-time friendly request to star the repo on GitHub.
function recordCaptureForStarPrompt() {
  const settings = loadSettings();
  if (settings.starPromptShown) return;
  const count = (settings.captureCount || 0) + 1;
  saveSetting("captureCount", count);
  if (count >= STAR_PROMPT_CAPTURE_THRESHOLD) {
    showStarPrompt();
  }
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

  // Show the card on the display where the capture happened (cursor location),
  // not always the primary monitor.
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  previewDisplay = display.workArea;

  // Stack above the existing unpinned previews. Pinned cards have been moved
  // out of the stack (they keep their own position), so counting them here
  // would leave a gap that repositionPreviews later closes with a visible jump.
  let stackOffset = 0;
  for (const p of previewWindows) {
    if (!p.window.isDestroyed() && !p.pinned) {
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
        canStudio: canOpenInStudio(entry),
        dismissSeconds: getDismissSeconds(),
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

// ── Studio ──
// One editor for stills and clips. `mode` is either "markup" (bare pixels,
// written back over the source, what the annotation editor used to be) or
// "compose" (framed on a background, saved as a brand-new file). Clips are
// always composed: there is no writing a PNG back over an mp4.

// Read a recorded clip plus its paired motion sidecar. Fresh QGN recordings
// have a sidecar; imported or older clips do not, and Studio degrades to no
// motion. Returns null (and toasts) when the file can't be read.
function readVideoPayload(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    showErrorToast("Couldn't find the video file to edit");
    return null;
  }
  if (!STUDIO_VIDEO_EXTS.has(fileExt(filePath))) {
    showErrorToast("Studio can't reopen GIF or WebP animations");
    return null;
  }
  let videoBytes;
  try {
    videoBytes = fs.readFileSync(filePath);
  } catch (e) {
    console.error("Failed to read source video:", e);
    showErrorToast("Couldn't open the video in Studio");
    return null;
  }
  let motionData = null;
  try {
    const motionPath = filePath.replace(/\.[^.]+$/, ".motion.json");
    if (fs.existsSync(motionPath)) {
      const parsed = JSON.parse(fs.readFileSync(motionPath, "utf8"));
      if (parsed && Array.isArray(parsed.events)) motionData = parsed;
    }
  } catch (e) {
    console.error("Failed to read motion sidecar:", e);
  }
  return {
    kind: "video",
    videoBytes: new Uint8Array(videoBytes),
    mimeType: videoMimeForPath(filePath),
    motion: motionData,
  };
}

// Hand the source to an open Studio renderer. Returns false when there was
// nothing loadable to send.
function sendStudioSource(win, previewEntry, mode) {
  if (!win || win.isDestroyed()) return false;
  if (!previewEntry) {
    win.webContents.send("studio-load", { kind: "none", mode });
    return true;
  }
  if (previewEntry.isVideo) {
    const payload = readVideoPayload(previewEntry.filePath);
    if (!payload) return false;
    win.webContents.send("studio-load", { ...payload, mode });
    return true;
  }
  if (!previewEntry.pngBuffer) return false;
  win.webContents.send("studio-load", {
    kind: "image",
    imageDataUrl: `data:image/png;base64,${Buffer.from(previewEntry.pngBuffer).toString("base64")}`,
    mode,
  });
  return true;
}

// Markup opens sized to the image so it feels like a quick markup pass;
// compose and clips open as a full workspace.
function studioWindowBounds(previewEntry, mode) {
  // Open on the display the user is actually working on, not always the
  // primary one: a preview card lives on the monitor its capture came from.
  const workArea = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  if (mode === "markup" && previewEntry && previewEntry.imgSize) {
    const { width, height } = previewEntry.imgSize;
    const maxW = Math.round(workArea.width * MARKUP_AREA_FRACTION);
    const maxH = Math.round(workArea.height * MARKUP_AREA_FRACTION);
    const scale = Math.min(1, (maxW - MARKUP_PAD) / width, (maxH - MARKUP_CHROME_H - MARKUP_PAD) / height);
    const winW = Math.max(MIN_MARKUP_W, Math.round(width * scale) + MARKUP_PAD);
    const winH = Math.max(MIN_MARKUP_H, Math.round(height * scale) + MARKUP_CHROME_H + MARKUP_PAD);
    return {
      width: winW,
      height: winH,
      x: workArea.x + Math.round((workArea.width - winW) / 2),
      y: workArea.y + Math.round((workArea.height - winH) / 2),
    };
  }
  const winW = Math.min(1280, Math.round(workArea.width * 0.92));
  const winH = Math.round(workArea.height * 0.9);
  return {
    width: winW,
    height: winH,
    x: workArea.x + Math.round((workArea.width - winW) / 2),
    y: workArea.y + Math.round((workArea.height - winH) / 2),
  };
}

// Find an already-open Studio showing this exact capture, so a second click on
// the same preview card focuses instead of stacking another window.
function findStudioFor(previewEntry) {
  for (const [win, entry] of studioWindows) {
    if (win.isDestroyed()) continue;
    if (!previewEntry) {
      if (!entry.previewEntry) return win;
      continue;
    }
    if (entry.previewEntry === previewEntry) return win;
    // Opening the same file a second time (tray → "Open video in Studio…")
    // builds a fresh entry object, so fall back to comparing paths.
    if (entry.previewEntry && previewEntry.filePath &&
        entry.previewEntry.filePath === previewEntry.filePath) return win;
  }
  return null;
}

function openStudio(previewEntry, opts = {}) {
  const mode = previewEntry && previewEntry.isVideo ? "compose" : (opts.mode === "markup" ? "markup" : "compose");

  const existing = findStudioFor(previewEntry || null);
  if (existing) {
    existing.focus();
    return;
  }

  const bounds = studioWindowBounds(previewEntry, mode);
  const win = new BrowserWindow({
    ...bounds,
    minWidth: mode === "markup" ? 600 : 900,
    minHeight: mode === "markup" ? 400 : 560,
    frame: false,
    backgroundColor: "#141414",
    resizable: true,
    skipTaskbar: false,
    show: false,
    webPreferences: secureWebPrefs("studio-preload.js", { backgroundThrottling: false }),
  });

  // A quick markup pass usually happens against something else on screen, so
  // keep that window above the rest. Switching to compose drops it.
  if (mode === "markup") win.setAlwaysOnTop(true, "screen-saver");

  studioWindows.set(win, { previewEntry: previewEntry || null, mode });
  win.loadFile("studio.html");

  win.once("ready-to-show", () => {
    if (win.isDestroyed()) return;
    win.show();
    // If the source vanished between opening and showing, don't leave an empty
    // editor stranded.
    if (!sendStudioSource(win, previewEntry, mode) && previewEntry) win.destroy();
  });

  win.on("closed", () => studioWindows.delete(win));
}

// Pick any existing video off disk and open it in Studio (so clips that have
// scrolled past their preview card can still be framed).
async function openVideoFileInStudio() {
  const result = await dialog.showOpenDialog({
    title: "Open a video in Studio",
    defaultPath: getSaveFolder(),
    properties: ["openFile"],
    filters: [{ name: "Video", extensions: ["mp4", "webm", "mov", "mkv", "m4v"] }],
  });
  if (result.canceled || !result.filePaths.length) return;
  openStudio({ filePath: result.filePaths[0], isVideo: true });
}

let videoSourceId = null;
let videoScaleFactor = 1;
let videoDisplaySize = { width: 0, height: 0 };
let videoDisplayOrigin = { x: 0, y: 0 };

// ── Mouse-motion capture ──
// During a recording we log global mouse move/click/wheel events (via the
// native uiohook module) so Studio can drive a synthetic cursor,
// click ripples, and click-triggered auto-zoom. Coordinates are normalized to
// the captured region [0..1] and timestamps are aligned to the video clock
// (which excludes paused time, mirroring the renderer's MediaRecorder.pause()).
let _uiohook; // lazily required; null once if it fails to load
function getUiohook() {
  if (_uiohook === undefined) {
    try {
      _uiohook = require("uiohook-napi");
    } catch (e) {
      console.error("uiohook-napi failed to load; motion capture disabled:", e);
      _uiohook = null;
    }
  }
  return _uiohook;
}

const motion = {
  active: false, // hook is running
  logging: false, // buffering events (false during pre-roll countdown / pause)
  t0: 0, // Date.now() at video currentTime 0
  pausedAccum: 0, // ms of paused time to subtract from timestamps
  pauseStart: 0,
  region: null, // { x, y, width, height } in physical px (display-relative)
  displayOrigin: { x: 0, y: 0 }, // display top-left in physical px (global)
  events: [],
};
let pendingMotion = null; // finalized capture, consumed by the next saveRecording

// Map a raw global uiohook screen point (physical px on Windows) to the
// recorded region's normalized space [0..1]. Returns null for points well
// outside the region so stray desktop movement doesn't pollute the track.
function normalizeMotionPoint(rawX, rawY) {
  const r = motion.region;
  if (!r || !(r.width > 0) || !(r.height > 0)) return null;
  const physX = rawX - motion.displayOrigin.x;
  const physY = rawY - motion.displayOrigin.y;
  const nx = (physX - r.x) / r.width;
  const ny = (physY - r.y) / r.height;
  if (nx < -0.2 || nx > 1.2 || ny < -0.2 || ny > 1.2) return null;
  const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
  return { x: clamp01(nx), y: clamp01(ny) };
}

function motionTime() {
  // A pause that is still open counts too, otherwise stopping while paused
  // would report a duration that includes the paused stretch.
  const openPause = motion.pauseStart ? Date.now() - motion.pauseStart : 0;
  return Math.max(0, (Date.now() - motion.t0 - motion.pausedAccum - openPause) / 1000);
}

function pushMotionEvent(type, rawX, rawY, extra) {
  if (!motion.logging) return;
  const p = normalizeMotionPoint(rawX, rawY);
  if (!p) return;
  // Cap the buffer so a very long recording can't grow unbounded (~30min at a
  // busy 250 evt/s is comfortably under this).
  if (motion.events.length >= 500000) return;
  motion.events.push({ t: +motionTime().toFixed(3), type, x: +p.x.toFixed(4), y: +p.y.toFixed(4), ...extra });
}

// Begin listening. `region` and `displayOrigin` are physical-px anchors from
// showOverlayForVideo/beginVideoRecording. Buffering stays off until the
// renderer signals recording actually started (post-countdown).
function startMotionCapture(region, displayOrigin) {
  const hook = getUiohook();
  if (!hook || !hook.uIOhook) return;
  motion.region = region;
  motion.displayOrigin = displayOrigin || { x: 0, y: 0 };
  motion.events = [];
  motion.logging = false;
  motion.pausedAccum = 0;
  motion.pauseStart = 0;
  motion.t0 = Date.now();
  if (motion.active) return; // listeners already attached
  const io = hook.uIOhook;
  // A previous start that threw can leave listeners behind; clearing first
  // keeps a retry from double-logging every event.
  try { io.removeAllListeners(); } catch (_) {}
  io.on("mousemove", (e) => pushMotionEvent("move", e.x, e.y));
  io.on("mousedown", (e) => pushMotionEvent("down", e.x, e.y, { button: e.button }));
  io.on("mouseup", (e) => pushMotionEvent("up", e.x, e.y, { button: e.button }));
  io.on("wheel", (e) => pushMotionEvent("wheel", e.x, e.y, { dy: e.rotation }));
  try {
    io.start();
    motion.active = true;
  } catch (e) {
    console.error("Failed to start uiohook:", e);
    motion.active = false;
    try { io.removeAllListeners(); } catch (_) {}
  }
}

// Called when the renderer reports the MediaRecorder actually started. `t0` is
// the renderer's Date.now() at that instant (same wall clock), so motion
// timestamps line up with video.currentTime.
function markMotionStarted(t0) {
  if (!motion.active) return;
  motion.t0 = typeof t0 === "number" && t0 > 0 ? t0 : Date.now();
  motion.pausedAccum = 0;
  motion.logging = true;
}

function pauseMotionCapture() {
  if (!motion.logging) return;
  motion.logging = false;
  motion.pauseStart = Date.now();
}

function resumeMotionCapture() {
  if (!motion.active || motion.pauseStart === 0) return;
  motion.pausedAccum += Date.now() - motion.pauseStart;
  motion.pauseStart = 0;
  motion.logging = true;
}

// Stop the hook and finalize the buffer into `pendingMotion` for the imminent
// saveRecording. Returns nothing; safe to call when inactive.
function stopMotionCapture() {
  if (!motion.active) {
    pendingMotion = null;
    return;
  }
  const hook = getUiohook();
  try {
    if (hook && hook.uIOhook) {
      hook.uIOhook.stop();
      hook.uIOhook.removeAllListeners();
    }
  } catch (e) {
    console.error("Failed to stop uiohook:", e);
  }
  const duration = motionTime();
  pendingMotion =
    motion.region && motion.events.length > 0
      ? {
          version: 1,
          recordedAt: new Date().toISOString(),
          region: { ...motion.region },
          scaleFactor: videoScaleFactor,
          duration: +duration.toFixed(3),
          events: motion.events,
        }
      : null;
  motion.active = false;
  motion.logging = false;
  motion.pauseStart = 0;
  motion.pausedAccum = 0;
  motion.events = [];
  motion.region = null;
}

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
  // Physical pixel dimensions of the display, so the recorder can request a
  // full-resolution (1:1) capture instead of Chromium's downscaled default.
  videoDisplaySize = {
    width: Math.round(display.bounds.width * display.scaleFactor),
    height: Math.round(display.bounds.height * display.scaleFactor),
  };
  // Physical-px global origin of the capture display, so raw uiohook screen
  // coordinates can be made display-relative for motion normalization.
  videoDisplayOrigin = {
    x: Math.round(display.bounds.x * display.scaleFactor),
    y: Math.round(display.bounds.y * display.scaleFactor),
  };

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

  recordingControlWindow.loadFile("record-control.html");
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
      // Recording bar closed mid-capture (abort): tear down the motion hook too.
      stopMotionCapture();
      pendingMotion = null;
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

  // The region comes from the overlay renderer; a malformed one would produce a
  // zero-sized capture canvas and a silently broken recording.
  const validRegion =
    region &&
    [region.x, region.y, region.width, region.height].every((n) => Number.isFinite(n)) &&
    region.width >= 1 && region.height >= 1;
  if (!validRegion) {
    dismissVideoSetup();
    showErrorToast("That selection was too small to record");
    return;
  }

  isRecording = true;

  // Show recording border on overlay
  overlayActive = false;
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.setIgnoreMouseEvents(true);
    overlayWindow.setContentProtection(true);
    overlayWindow.webContents.send("overlay-show-rec-border", region);
  }

  // Resize control window for the recording phase (now includes a Pause
  // button) and keep it centered.
  const recBounds = recordingControlWindow.getBounds();
  recordingControlWindow.setBounds({
    x: recBounds.x - 25,
    y: recBounds.y,
    width: 280,
    height: recBounds.height,
  });

  const physicalRegion = {
    x: Math.round(region.x * videoScaleFactor),
    y: Math.round(region.y * videoScaleFactor),
    width: Math.round(region.width * videoScaleFactor),
    height: Math.round(region.height * videoScaleFactor),
  };

  // Begin global mouse capture now; buffering waits for "recording-started"
  // (fired by the renderer after any pre-roll countdown).
  startMotionCapture(physicalRegion, videoDisplayOrigin);

  recordingControlWindow.webContents.send("start-recording", {
    sourceId: videoSourceId,
    countdown: getRecordCountdown(),
    display: {
      width: videoDisplaySize.width,
      height: videoDisplaySize.height,
    },
    region: physicalRegion,
  });

  videoSourceId = null;
}

function stopRecordingUI() {
  // Ensure the motion hook is torn down; discard any buffer not already
  // consumed by a save (e.g. a cancelled recording).
  stopMotionCapture();
  pendingMotion = null;

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

// Write a video/animation buffer to the save folder and surface it the same way
// a fresh recording is: a preview card (with its captured thumbnail) or a toast.
// Shared by the recorder and Studio's clip export. Returns the written path.
function writeVideoFile(buffer, ext, thumbnailDataUrl) {
  const folder = getSaveFolder();
  fs.mkdirSync(folder, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filePath = path.join(folder, `qgn-${timestamp}.${ext}`);
  fs.writeFileSync(filePath, Buffer.from(buffer));

  // Pair a motion sidecar with a fresh recording (only when we captured events;
  // Studio re-exports leave pendingMotion null and get no sidecar).
  if (pendingMotion) {
    try {
      const motionPath = filePath.replace(/\.[^.]+$/, ".motion.json");
      fs.writeFileSync(motionPath, JSON.stringify(pendingMotion));
    } catch (e) {
      console.error("Failed to write motion sidecar:", e);
    }
    pendingMotion = null;
  }

  if (thumbnailDataUrl && /^data:image\/png;base64,/.test(thumbnailDataUrl)) {
    const base64 = thumbnailDataUrl.replace(/^data:image\/png;base64,/, "");
    const pngBuffer = Buffer.from(base64, "base64");
    const image = nativeImage.createFromBuffer(pngBuffer);
    showPreview(new Uint8Array(pngBuffer), image.getSize(), filePath, true);
  } else {
    showToast("saved");
  }
  recordCaptureForStarPrompt();
  return filePath;
}

function saveRecording(data, thumbnailDataUrl, format) {
  try {
    // Finalize the motion buffer into pendingMotion before writing, so
    // writeVideoFile can drop the sidecar next to the video.
    stopMotionCapture();
    const ext = format === "mp4" ? "mp4" : "webm";
    writeVideoFile(data, ext, thumbnailDataUrl);
    stopRecordingUI();
  } catch (e) {
    console.error("Failed to save recording:", e);
    showErrorToast("Couldn't save the recording");
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
    { label: "Capture full screen", click: captureFullScreen },
    { label: "Open Studio", click: () => openStudio() },
    { label: "Annotate clipboard image", click: () => studioClipboard("markup") },
    { label: "Open clipboard image in Studio", click: () => studioClipboard("compose") },
    { label: "Open video in Studio...", click: openVideoFileInStudio },
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
  const winH = 480; // initial; the renderer resizes to fit its content

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

function updateTrayTooltip() {
  if (!tray) return;
  const hk = getHotkeys();
  tray.setToolTip(`qgn — ${hotkeyToLabel(hk.capture)} capture, ${hotkeyToLabel(hk.record)} record`);
}

function createTray() {
  const trayIcon = nativeImage.createFromPath(
    path.join(__dirname, "icons", "tray.png")
  );
  tray = new Tray(trayIcon);
  updateTrayTooltip();
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

// The version string comes from the update feed, so it is validated before it
// is ever pasted into a URL. Null means "don't show a version".
let pendingUpdateVersion = null;
function validVersion(v) {
  return typeof v === "string" && /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(v) ? v : null;
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

  getAutoUpdater().on("update-available", (info) => {
    // A repeated check must not leave the previous watchdog running, or it
    // would fire a bogus "timed out" over a healthy download.
    if (downloadStallTimer) {
      clearTimeout(downloadStallTimer);
      downloadStallTimer = null;
    }
    pendingUpdateVersion = validVersion(info && info.version);
    pendingStatus = { status: "downloading", percent: 0, version: pendingUpdateVersion };
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
    sendUpdateStatus({ status: "downloading", percent: progress.percent, version: pendingUpdateVersion });
  });

  getAutoUpdater().on("update-downloaded", (info) => {
    if (downloadStallTimer) {
      clearTimeout(downloadStallTimer);
      downloadStallTimer = null;
    }
    pendingUpdateVersion = validVersion(info && info.version) || pendingUpdateVersion;
    if (updateWindow && !updateWindow.isDestroyed()) {
      sendUpdateStatus({ status: "ready", version: pendingUpdateVersion });
    } else {
      pendingStatus = { status: "ready", version: pendingUpdateVersion };
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
  // A second instance that failed to get the lock is quitting; do no setup.
  if (!hasInstanceLock) return;

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

  // "What's new" on the update card: open the release page for the version
  // being installed, which is where the release notes live.
  ipcMain.on("update-notes", () => {
    shell.openExternal(
      pendingUpdateVersion ? `${REPO_URL}/releases/tag/v${pendingUpdateVersion}` : `${REPO_URL}/releases`
    );
  });

  ipcMain.on("update-dismiss", () => {
    if (updateWindow && !updateWindow.isDestroyed()) {
      updateWindow.destroy();
      updateWindow = null;
    }
  });

  // Open the GitHub repo and close the star prompt (if it's the source).
  ipcMain.on("star-open", () => {
    shell.openExternal(REPO_URL);
    closeStarPrompt();
  });

  ipcMain.on("star-dismiss", () => {
    closeStarPrompt();
  });

  ipcMain.on("capture-region", async (_event, region) => {
    // Validate the selection coming from the renderer.
    const valid =
      region &&
      [region.x, region.y, region.width, region.height, region.viewportWidth, region.viewportHeight]
        .every((n) => Number.isFinite(n)) &&
      region.width > 0 && region.height > 0 &&
      region.viewportWidth > 0 && region.viewportHeight > 0;

    // Stop intercepting the mouse and clear the selection UI, but keep the
    // overlay content-protected until the capture resolves so the dimming can't
    // leak into a frame that may still be in flight.
    overlayActive = false;
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.webContents.send("overlay-clear");
      overlayWindow.setIgnoreMouseEvents(true);
      overlayWindow.blur();
    }

    const image = pendingScreenshot ? await pendingScreenshot : null;
    pendingScreenshot = null;

    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.setContentProtection(false);
    }

    if (!valid || !image || image.isEmpty()) return;

    const size = image.getSize();
    const scaleX = size.width / region.viewportWidth;
    const scaleY = size.height / region.viewportHeight;
    let x = Math.round(region.x * scaleX);
    let y = Math.round(region.y * scaleY);
    let w = Math.round(region.width * scaleX);
    let h = Math.round(region.height * scaleY);

    // Clamp to the captured image bounds.
    x = Math.max(0, Math.min(x, size.width - 1));
    y = Math.max(0, Math.min(y, size.height - 1));
    w = Math.max(1, Math.min(w, size.width - x));
    h = Math.max(1, Math.min(h, size.height - y));

    const crop = image.crop({ x, y, width: w, height: h });
    handleCaptureData(crop.toPNG());
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

  // Motion-capture lifecycle, reported by the recorder so timestamps align with
  // the video clock (which excludes paused time).
  ipcMain.on("recording-started", (_event, startTime) => markMotionStarted(startTime));
  ipcMain.on("recording-paused", () => pauseMotionCapture());
  ipcMain.on("recording-resumed", () => resumeMotionCapture());

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


  // The pencil opens Studio straight into markup; the Studio button opens it
  // into compose. Same window either way.
  ipcMain.on("preview-edit", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const entry = previewWindows.find((p) => p.window === win);
    if (entry) openStudio(entry, { mode: "markup" });
  });

  ipcMain.on("preview-studio", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const entry = previewWindows.find((p) => p.window === win);
    if (!entry) return;
    if (!canOpenInStudio(entry)) {
      showErrorToast("Studio can't reopen GIF or WebP animations");
      return;
    }
    openStudio(entry, { mode: "compose" });
  });

  ipcMain.on("preview-copy", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const entry = previewWindows.find((p) => p.window === win);
    if (entry && entry.pngBuffer) {
      const image = nativeImage.createFromBuffer(Buffer.from(entry.pngBuffer));
      copyToClipboard(image);
      showToast("copied");
    }
  });

  ipcMain.on("preview-start-drag", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const entry = previewWindows.find((p) => p.window === win);
    if (!entry) return;

    // Prefer the real saved file; otherwise materialize a temp PNG so the
    // capture can still be dragged into other apps when save-to-disk is off.
    let filePath = entry.filePath;
    if (!filePath || !fs.existsSync(filePath)) {
      try {
        filePath = path.join(app.getPath("temp"), `qgn-drag-${Date.now()}.png`);
        const image = nativeImage.createFromBuffer(Buffer.from(entry.pngBuffer));
        fs.writeFileSync(filePath, image.toPNG());
        // Remember it so the session cleans up after itself on quit; the drop
        // target has already copied the bytes by then.
        dragTempFiles.add(filePath);
      } catch (e) {
        console.error("Failed to prepare drag file:", e);
        return;
      }
    }

    let icon = nativeImage.createFromBuffer(Buffer.from(entry.pngBuffer));
    try { icon = icon.resize({ width: 128 }); } catch {}
    if (icon.isEmpty()) {
      icon = nativeImage.createFromPath(path.join(__dirname, "icons", "icon-64.png"));
    }

    try {
      win.webContents.startDrag({ file: filePath, icon });
    } catch (e) {
      console.error("startDrag failed:", e);
    }
  });

  // Markup mode: the edited image replaces the original in place.
  ipcMain.on("studio-overwrite", async (event, pngBuffer) => {
    if (!(pngBuffer instanceof Uint8Array) && !Buffer.isBuffer(pngBuffer)) return;
    const image = nativeImage.createFromBuffer(Buffer.from(pngBuffer));
    if (image.isEmpty()) return;
    copyToClipboard(image);

    const win = BrowserWindow.fromWebContents(event.sender);
    const studio = studioWindows.get(win);
    const src = studio ? studio.previewEntry : null;

    if (src && src.fromClipboard) {
      // Annotating a clipboard image: treat the result as a fresh capture
      // (save to disk if enabled, show a preview card).
      handleCaptureData(Buffer.from(pngBuffer));
    } else if (src) {
      try {
        if (src.filePath && !src.isVideo) {
          // Re-encode to match the file's real format instead of writing PNG
          // bytes under a .jpg/.webp/.txt extension.
          await writeImageToPath(image, src.filePath);
        }
      } catch (e) {
        console.error("Failed to write annotated file:", e);
        showErrorToast("Couldn't save annotation to disk");
      }
      src.pngBuffer = pngBuffer;

      // Update persisted pinned image copy (always PNG in pinnedDataDir)
      if (src.pinnedImagePath && src.pinnedImagePath !== src.filePath) {
        try {
          fs.writeFileSync(src.pinnedImagePath, image.toPNG());
        } catch (e) {
          console.error("Failed to write pinned image:", e);
        }
      }

      if (src.window && !src.window.isDestroyed()) {
        const imageDataUrl = `data:image/png;base64,${Buffer.from(pngBuffer).toString("base64")}`;
        src.window.webContents.send("update-preview", { imageDataUrl });
      }
    }

    if (win && !win.isDestroyed()) win.destroy();
  });

  ipcMain.on("studio-copy", (event, pngBuffer) => {
    if (!(pngBuffer instanceof Uint8Array) && !Buffer.isBuffer(pngBuffer)) return;
    const image = nativeImage.createFromBuffer(Buffer.from(pngBuffer));
    if (image.isEmpty()) return;
    copyToClipboard(image);
    showToast("copied");
  });

  ipcMain.on("studio-save", (event, pngBuffer) => {
    if (!(pngBuffer instanceof Uint8Array) && !Buffer.isBuffer(pngBuffer)) return;
    // The composed mockup is a new image (background + frame, different size),
    // so treat it as a fresh capture rather than overwriting the source.
    handleCaptureData(Buffer.from(pngBuffer));
    // The export replaces the source visually, so retire the originating preview
    // card instead of leaving a stale duplicate alongside the new one.
    const win = BrowserWindow.fromWebContents(event.sender);
    const studio = studioWindows.get(win);
    const src = studio ? studio.previewEntry : null;
    if (src && src.window && !src.window.isDestroyed()) src.window.close();
    if (win && !win.isDestroyed()) win.destroy();
  });

  ipcMain.on("studio-cancel", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && !win.isDestroyed()) win.destroy();
  });

  // Markup windows float above other apps; compose windows don't. The renderer
  // owns the mode, so it tells us when that changes.
  ipcMain.on("studio-set-always-on-top", (event, flag) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed() || !studioWindows.has(win)) return;
    if (flag) win.setAlwaysOnTop(true, "screen-saver");
    else win.setAlwaysOnTop(false);
  });

  ipcMain.handle("studio-get-colors", () => getStudioColors());

  ipcMain.on("studio-save-colors", (event, colors) => {
    const clean = sanitizeStudioColors(colors);
    if (clean) saveSetting("studioColors", clean);
  });

  ipcMain.handle("studio-get-gradients", () => getStudioGradients());

  ipcMain.on("studio-save-gradients", (event, gradients) => {
    const clean = sanitizeStudioGradients(gradients);
    if (clean) saveSetting("studioGradients", clean);
  });

  // ── Clip export ──
  // A finished mp4/webm produced by the renderer's MediaRecorder: write it out
  // as a brand-new file (background + frame baked in), like a fresh recording.
  ipcMain.on("studio-export-encoded", (event, payload) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    try {
      const bytes = payload && payload.bytes;
      if (!(bytes instanceof Uint8Array) && !Buffer.isBuffer(bytes)) throw new Error("no video data");
      const ext = payload.format === "webm" ? "webm" : "mp4";
      writeVideoFile(bytes, ext, payload.thumbnailDataUrl);
      if (win && !win.isDestroyed()) win.destroy();
    } catch (e) {
      console.error("Failed to save Studio clip export:", e);
      showErrorToast("Couldn't save the video");
      if (win && !win.isDestroyed()) win.webContents.send("studio-export-error", "Couldn't save the video.");
    }
  });

  // A sequence of PNG frames to assemble into an animated GIF/WebP. The
  // assembly itself lives in lib/animation.js so it can be tested on its own.
  ipcMain.on("studio-export-frames", async (event, payload) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    let result;
    try {
      result = await assembleAnimation(payload);
    } catch (e) {
      result = { ok: false, reason: e && e.message, userMessage: "Couldn't render the animation." };
    }
    if (!result.ok) {
      console.error("Studio animation export failed:", result.reason);
      showErrorToast(result.userMessage);
      if (win && !win.isDestroyed()) win.webContents.send("studio-export-error", result.userMessage);
      return;
    }
    try {
      writeVideoFile(result.buffer, result.ext, payload && payload.thumbnailDataUrl);
      if (win && !win.isDestroyed()) win.destroy();
    } catch (e) {
      console.error("Failed to save the animation:", e);
      showErrorToast("Couldn't save the animation");
      if (win && !win.isDestroyed()) win.webContents.send("studio-export-error", "Couldn't save the animation.");
    }
  });

  function currentSettingsPayload() {
    return {
      copyFormat: getCopyFormat(),
      saveToDisk: getSaveToDisk(),
      saveFolder: getSaveFolder(),
      hotkeys: getHotkeys(),
      startOnStartup: getStartOnStartup(),
      imageQuality: getImageQuality(),
      dismissSeconds: getDismissSeconds(),
      recordCountdown: getRecordCountdown(),
    };
  }

  ipcMain.handle("get-settings", () => currentSettingsPayload());

  function sendSettingsUpdate() {
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.webContents.send("settings-updated", currentSettingsPayload());
    }
  }

  ipcMain.on("set-copy-format", (_event, fmt) => {
    const VALID_FORMATS = ["png", "jpg", "webp", "base64"];
    if (!VALID_FORMATS.includes(fmt)) return;
    saveSetting("copyFormat", fmt);
    rebuildTrayMenu();
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

    // Reject a shortcut already bound to the other action.
    const other = action === "capture" ? "record" : "capture";
    if (getHotkeys()[other] === accelerator) {
      if (settingsWindow && !settingsWindow.isDestroyed()) {
        settingsWindow.webContents.send("hotkey-error", {
          action,
          message: `Already used by ${other === "capture" ? "Capture" : "Record"}`,
        });
      }
      return;
    }

    // Validate the accelerator by attempting to register it first
    try {
      globalShortcut.register(accelerator, () => {});
      globalShortcut.unregister(accelerator);
    } catch (e) {
      console.error("Invalid accelerator:", accelerator, e);
      if (settingsWindow && !settingsWindow.isDestroyed()) {
        settingsWindow.webContents.send("hotkey-error", { action, message: "Invalid shortcut" });
      }
      return;
    }
    saveSetting(`hotkey_${action}`, accelerator);
    registerHotkeys();
    rebuildTrayMenu();
    updateTrayTooltip();
    sendSettingsUpdate();
  });

  ipcMain.on("reset-hotkeys", () => {
    saveSetting("hotkey_capture", defaultHotkeys.capture);
    saveSetting("hotkey_record", defaultHotkeys.record);
    registerHotkeys();
    rebuildTrayMenu();
    updateTrayTooltip();
    sendSettingsUpdate();
  });

  ipcMain.on("set-image-quality", (_event, value) => {
    const q = Number(value);
    if (!Number.isFinite(q) || q < 1 || q > 100) return;
    saveSetting("imageQuality", Math.round(q));
    sendSettingsUpdate();
  });

  ipcMain.on("set-dismiss-seconds", (_event, value) => {
    const v = Number(value);
    if (!Number.isFinite(v) || v < 0 || v > 600) return;
    saveSetting("dismissSeconds", Math.round(v));
    sendSettingsUpdate();
  });

  ipcMain.on("set-record-countdown", (_event, value) => {
    const v = Number(value);
    if (!Number.isFinite(v) || v < 0 || v > 10) return;
    saveSetting("recordCountdown", Math.round(v));
    sendSettingsUpdate();
  });

  ipcMain.on("open-save-folder", () => {
    const folder = getSaveFolder();
    try {
      fs.mkdirSync(folder, { recursive: true });
    } catch {}
    shell.openPath(folder);
  });

  // Resize the settings popover to fit its content, keeping it anchored above
  // the tray icon.
  ipcMain.on("settings-resize", (event, height) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed() || win !== settingsWindow || !tray) return;
    const h = Math.max(120, Math.min(900, Math.round(Number(height) || 0)));
    if (!h) return;
    const b = win.getBounds();
    const tb = tray.getBounds();
    win.setBounds({ x: b.x, y: Math.round(tb.y - h - 4), width: b.width, height: h });
  });

  ipcMain.on("recording-error", (_event, message) => {
    showErrorToast(typeof message === "string" && message ? message : "Recording failed");
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
  for (const f of dragTempFiles) {
    try { fs.unlinkSync(f); } catch {}
  }
  dragTempFiles.clear();
});

app.on("window-all-closed", () => {});
