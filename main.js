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
} = require("electron");
const path = require("path");

// Software rendering avoids GPU compositing conflicts with hardware-accelerated
// video in other apps (e.g. YouTube goes black under transparent windows)
app.disableHardwareAcceleration();

let overlayWindow = null;
let tray = null;
let capturedImage = null;
let capturedScaleFactor = 1;
let overlayReady = false;
let overlayActive = false;

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
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      backgroundThrottling: false,
    },
  });

  overlayWindow.loadFile("overlay.html");
  overlayWindow.setAlwaysOnTop(true, "screen-saver");

  // Show window once so subsequent activations don't trigger the
  // Windows DWM window-open animation that causes a double-flash.
  overlayWindow.once("ready-to-show", () => {
    overlayWindow.showInactive();
    overlayWindow.setIgnoreMouseEvents(true);
    overlayReady = true;
  });
}

async function showOverlay() {
  if (!overlayWindow || !overlayReady || overlayActive) return;
  overlayActive = true;

  const cursorPoint = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursorPoint);
  const scaleFactor = display.scaleFactor;
  capturedScaleFactor = scaleFactor;

  // Capture screen BEFORE showing overlay so the result is always clean
  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: {
      width: display.size.width * scaleFactor,
      height: display.size.height * scaleFactor,
    },
  });

  const source =
    sources.find((s) => s.display_id === String(display.id)) || sources[0];
  if (!source) {
    overlayActive = false;
    return;
  }

  capturedImage = source.thumbnail;

  // Position overlay on the correct display, render content, and activate
  const { x, y, width, height } = display.bounds;
  overlayWindow.setBounds({ x, y, width, height });
  overlayWindow.setIgnoreMouseEvents(false);
  overlayWindow.webContents.executeJavaScript("reset()");
  overlayWindow.focus();
}

function hideOverlay() {
  if (!overlayWindow) return;
  overlayActive = false;
  overlayWindow.setIgnoreMouseEvents(true);
  overlayWindow.webContents.executeJavaScript(
    'document.getElementById("overlay").innerHTML = ""'
  );
  overlayWindow.blur();
}

function cropAndCopy(region) {
  if (!capturedImage) return;

  const cropped = capturedImage.crop({
    x: Math.round(region.x * capturedScaleFactor),
    y: Math.round(region.y * capturedScaleFactor),
    width: Math.round(region.width * capturedScaleFactor),
    height: Math.round(region.height * capturedScaleFactor),
  });

  clipboard.writeImage(cropped);
  capturedImage = null;
}

function createTray() {
  const trayIcon = nativeImage.createFromPath(
    path.join(__dirname, "icons", "tray.png")
  );
  tray = new Tray(trayIcon);
  tray.setToolTip("qgn — Ctrl+Q to capture");

  const contextMenu = Menu.buildFromTemplate([
    { label: "Capture (Ctrl+Q)", click: showOverlay },
    { type: "separator" },
    { label: "Quit", click: () => app.quit() },
  ]);

  tray.setContextMenu(contextMenu);
}

app.whenReady().then(() => {
  createOverlay();
  createTray();

  globalShortcut.register("CommandOrControl+Q", showOverlay);

  ipcMain.on("capture", (_event, region) => {
    hideOverlay();
    cropAndCopy(region);
  });

  ipcMain.on("cancel", () => {
    hideOverlay();
    capturedImage = null;
  });
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
});

app.on("window-all-closed", (e) => e.preventDefault());
