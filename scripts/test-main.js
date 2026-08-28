// Boot main.js under a stubbed Electron.
//
// main.js is one big module whose whole boot path (window creation, tray menu,
// hotkeys, and every ipcMain registration) only runs inside app.whenReady().
// A syntax check proves none of that works. This loads the real file against a
// fake `electron`, lets the ready handler run, and then calls the IPC handlers
// with hostile payloads to check the validation actually holds.
//
// Pure Node: no display, no native modules, safe to run in CI.
const assert = require("assert");
const path = require("path");
const os = require("os");
const fs = require("fs");
const Module = require("module");

const cases = [];
function test(name, fn) { cases.push({ name, fn }); }

/* ───────────────────────── Electron stub ───────────────────────── */
const calls = {
  windows: [],
  trays: [],
  shortcuts: [],
  ipcOn: new Map(),
  ipcHandle: new Map(),
  loginItem: null,
  trayMenus: [],
  clipboardImages: 0,
  clipboardText: 0,
  openedExternal: [],
};

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "qgn-test-"));

function makeWebContents(win) {
  return {
    win,
    sent: [],
    send(channel, ...args) { this.sent.push({ channel, args }); },
    on() {}, once() {}, setWindowOpenHandler() {},
    executeJavaScript() { return Promise.resolve(); },
    startDrag() {},
  };
}

let nextWinId = 1;
class FakeBrowserWindow {
  constructor(opts = {}) {
    this.id = nextWinId++;
    this.opts = opts;
    this.destroyed = false;
    this.visible = false;
    this.listeners = new Map();
    this.onceListeners = new Map();
    this.bounds = { x: opts.x || 0, y: opts.y || 0, width: opts.width || 100, height: opts.height || 100 };
    this.webContents = makeWebContents(this);
    this.loadedFile = null;
    calls.windows.push(this);
  }
  loadFile(f) { this.loadedFile = f; return Promise.resolve(); }
  on(evt, cb) { if (!this.listeners.has(evt)) this.listeners.set(evt, []); this.listeners.get(evt).push(cb); return this; }
  once(evt, cb) { if (!this.onceListeners.has(evt)) this.onceListeners.set(evt, []); this.onceListeners.get(evt).push(cb); return this; }
  removeAllListeners(evt) { this.listeners.delete(evt); return this; }
  emit(evt, ...args) {
    for (const cb of this.onceListeners.get(evt) || []) cb(...args);
    this.onceListeners.delete(evt);
    for (const cb of this.listeners.get(evt) || []) cb(...args);
  }
  isDestroyed() { return this.destroyed; }
  destroy() { this.destroyed = true; this.emit("closed"); }
  close() { this.destroy(); }
  show() { this.visible = true; }
  showInactive() { this.visible = true; }
  hide() { this.visible = false; }
  isVisible() { return this.visible; }
  focus() {} blur() {}
  setAlwaysOnTop() {} setIgnoreMouseEvents() {} setContentProtection() {}
  setBounds(b) { Object.assign(this.bounds, b); }
  getBounds() { return { ...this.bounds }; }
}
FakeBrowserWindow.fromWebContents = (wc) => (wc && wc.win) || null;

function fakeImage(w = 100, h = 50, empty = false) {
  return {
    toPNG: () => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]),
    getSize: () => ({ width: w, height: h }),
    isEmpty: () => empty,
    resize: () => fakeImage(w, h, empty),
    crop: () => fakeImage(w, h, empty),
  };
}

const display = {
  id: 1,
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  size: { width: 1920, height: 1080 },
  workArea: { x: 0, y: 0, width: 1920, height: 1040 },
  workAreaSize: { width: 1920, height: 1040 },
  scaleFactor: 1,
};

const appEvents = new Map();
const electronStub = {
  app: {
    isPackaged: true,
    _ready: null,
    whenReady() { return Promise.resolve(); },
    on(evt, cb) { if (!appEvents.has(evt)) appEvents.set(evt, []); appEvents.get(evt).push(cb); },
    emit(evt, ...args) { for (const cb of appEvents.get(evt) || []) cb(...args); },
    quit() {}, exit() {},
    requestSingleInstanceLock: () => true,
    disableHardwareAcceleration() {},
    getPath(name) {
      const dir = path.join(userDataDir, name);
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    },
    setLoginItemSettings(v) { calls.loginItem = v; },
    commandLine: { appendSwitch() {} },
  },
  BrowserWindow: FakeBrowserWindow,
  globalShortcut: {
    register(acc) { calls.shortcuts.push(acc); return true; },
    unregister() {},
    unregisterAll() { calls.shortcuts.length = 0; },
  },
  desktopCapturer: {
    getSources: () => Promise.resolve([{ id: "screen:0", display_id: "1", thumbnail: fakeImage(1920, 1080) }]),
  },
  clipboard: {
    writeImage() { calls.clipboardImages++; },
    writeText() { calls.clipboardText++; },
    readImage: () => fakeImage(),
  },
  nativeImage: {
    createFromPath: () => fakeImage(),
    createFromBuffer: () => fakeImage(),
  },
  screen: {
    getPrimaryDisplay: () => display,
    getDisplayNearestPoint: () => display,
    getCursorScreenPoint: () => ({ x: 10, y: 10 }),
    on() {},
  },
  ipcMain: {
    on(channel, cb) { calls.ipcOn.set(channel, cb); },
    handle(channel, cb) { calls.ipcHandle.set(channel, cb); },
  },
  Tray: class {
    constructor(icon) { this.icon = icon; calls.trays.push(this); }
    setToolTip(t) { this.tooltip = t; }
    setContextMenu(m) { calls.trayMenus.push(m); }
    getBounds() { return { x: 1800, y: 1040, width: 24, height: 24 }; }
  },
  Menu: { buildFromTemplate: (tpl) => tpl },
  dialog: { showOpenDialog: () => Promise.resolve({ canceled: true, filePaths: [] }) },
  shell: {
    openExternal(u) { calls.openedExternal.push(u); },
    openPath() {}, showItemInFolder() {},
  },
};

const autoUpdaterStub = {
  autoDownload: false,
  autoInstallOnAppQuit: false,
  logger: null,
  on() {},
  checkForUpdates: () => Promise.resolve(),
  quitAndInstall() {},
};

// Intercept the two module ids main.js pulls from outside the repo.
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "electron") return electronStub;
  if (request === "electron-updater") return { autoUpdater: autoUpdaterStub };
  if (request === "electron-reloader") return () => {};
  return originalLoad.apply(this, arguments);
};

let bootError = null;
try {
  require("../main.js");
} catch (e) {
  bootError = e;
}

/* ───────────────────────── Tests ───────────────────────── */
test("main.js boots without throwing", () => {
  assert.strictEqual(bootError, null, bootError && bootError.stack);
});

test("the overlay and tray are created on ready", () => {
  assert.ok(calls.windows.some((w) => w.loadedFile === "overlay.html"), "no overlay window");
  assert.strictEqual(calls.trays.length, 1, "expected exactly one tray icon");
  assert.ok(calls.trayMenus.length > 0, "tray menu was never built");
});

test("both global hotkeys register", () => {
  assert.deepStrictEqual(calls.shortcuts, ["CommandOrControl+Q", "CommandOrControl+Shift+Q"]);
});

test("startup login item follows the setting", () => {
  assert.deepStrictEqual(calls.loginItem, { openAtLogin: true });
});

test("every channel the preloads talk to has a handler", () => {
  // Gathered from preload.js and the *-preload.js bridges: if one of these
  // loses its main-side handler, that feature silently stops working.
  const expectedOn = [
    "capture-region", "cancel", "close-mic-dropdown", "open-mic-dropdown",
    "start-video-recording", "save-recording", "recording-error",
    "recording-started", "recording-paused", "recording-resumed",
    "mic-device-selected",
    "close-preview", "preview-pin", "preview-set-bounds", "preview-open-file",
    "preview-edit", "preview-studio", "preview-copy", "preview-start-drag",
    "studio-copy", "studio-save", "studio-overwrite", "studio-cancel",
    "studio-set-always-on-top", "studio-save-colors", "studio-save-gradients",
    "studio-export-encoded", "studio-export-frames",
    "set-copy-format", "set-save-to-disk", "set-start-on-startup", "set-hotkey",
    "reset-hotkeys", "set-image-quality", "set-dismiss-seconds",
    "set-record-countdown", "open-save-folder", "choose-save-folder", "settings-resize",
    "welcome-close", "welcome-open-settings", "update-install", "update-dismiss",
    "star-open", "star-dismiss", "update-notes",
  ];
  const missing = expectedOn.filter((c) => !calls.ipcOn.has(c));
  assert.deepStrictEqual(missing, [], "unhandled channels: " + missing.join(", "));

  const expectedHandle = ["get-settings", "get-welcome-hotkeys", "get-selected-mic-id",
    "preview-get-bounds", "studio-get-colors", "studio-get-gradients"];
  const missingH = expectedHandle.filter((c) => !calls.ipcHandle.has(c));
  assert.deepStrictEqual(missingH, [], "unhandled invoke channels: " + missingH.join(", "));
});

// A fake sender for handlers that look the window up from the event.
function senderFor(win) { return { sender: win.webContents }; }
const scratchWin = new FakeBrowserWindow({});

function fire(channel, ...args) {
  const cb = calls.ipcOn.get(channel);
  assert.ok(cb, "no handler for " + channel);
  return cb(senderFor(scratchWin), ...args);
}

test("settings writers reject junk instead of persisting it", () => {
  const settingsPath = path.join(userDataDir, "userData", "settings.json");
  const read = () => { try { return JSON.parse(fs.readFileSync(settingsPath, "utf8")); } catch { return {}; } };

  fire("set-copy-format", "exe");
  fire("set-copy-format", null);
  fire("set-copy-format", { toString: () => "png" });
  assert.strictEqual(read().copyFormat, undefined, "an invalid copy format was persisted");
  fire("set-copy-format", "webp");
  assert.strictEqual(read().copyFormat, "webp");

  for (const bad of [-1, 0, 101, NaN, Infinity, "high", null]) fire("set-image-quality", bad);
  assert.strictEqual(read().imageQuality, undefined, "an invalid quality was persisted");
  fire("set-image-quality", 75);
  assert.strictEqual(read().imageQuality, 75);

  for (const bad of [-5, 601, NaN, "soon"]) fire("set-dismiss-seconds", bad);
  assert.strictEqual(read().dismissSeconds, undefined);
  fire("set-dismiss-seconds", 20);
  assert.strictEqual(read().dismissSeconds, 20);

  for (const bad of [-1, 11, NaN, "three"]) fire("set-record-countdown", bad);
  assert.strictEqual(read().recordCountdown, undefined);
  fire("set-record-countdown", 0);
  assert.strictEqual(read().recordCountdown, 0);
});

test("hotkeys reject unknown actions, oversized strings and duplicates", () => {
  const settingsPath = path.join(userDataDir, "userData", "settings.json");
  const read = () => { try { return JSON.parse(fs.readFileSync(settingsPath, "utf8")); } catch { return {}; } };

  fire("set-hotkey", { action: "explode", accelerator: "Ctrl+K" });
  assert.strictEqual(read().hotkey_explode, undefined);

  fire("set-hotkey", { action: "capture", accelerator: "x".repeat(500) });
  assert.strictEqual(read().hotkey_capture, undefined, "an oversized accelerator was persisted");

  // Binding capture to the shortcut record already owns must be refused.
  fire("set-hotkey", { action: "capture", accelerator: "CommandOrControl+Shift+Q" });
  assert.strictEqual(read().hotkey_capture, undefined, "a duplicate shortcut was accepted");

  fire("set-hotkey", { action: "capture", accelerator: "CommandOrControl+8" });
  assert.strictEqual(read().hotkey_capture, "CommandOrControl+8");
});

test("the palette writers only persist valid entries", () => {
  const settingsPath = path.join(userDataDir, "userData", "settings.json");
  const read = () => JSON.parse(fs.readFileSync(settingsPath, "utf8"));

  fire("studio-save-colors", "not-a-list");
  assert.strictEqual(read().studioColors, undefined);
  fire("studio-save-colors", ["#ff0000", "nope", 7]);
  assert.deepStrictEqual(read().studioColors, ["#FF0000"]);

  fire("studio-save-gradients", { angle: 1 });
  assert.strictEqual(read().studioGradients, undefined);
  fire("studio-save-gradients", [{ angle: 400, c0: "#000000", c1: "#ffffff" }, { c0: "bad" }]);
  assert.deepStrictEqual(read().studioGradients, [{ angle: 40, c0: "#000000", c1: "#FFFFFF" }]);
});

test("preview bounds reject malformed or absurdly small rects", () => {
  const before = { ...scratchWin.bounds };
  fire("preview-set-bounds", null);
  fire("preview-set-bounds", { x: "1", y: 2, width: 300, height: 300 });
  fire("preview-set-bounds", { x: 1, y: 2, width: 10, height: 10 });
  assert.deepStrictEqual(scratchWin.bounds, before, "a bad bounds payload moved the window");
  fire("preview-set-bounds", { x: 5, y: 6, width: 300, height: 200 });
  assert.deepStrictEqual(scratchWin.bounds, { x: 5, y: 6, width: 300, height: 200 });
});

test("studio output channels ignore non-binary payloads", () => {
  const before = calls.clipboardImages + calls.clipboardText;
  fire("studio-copy", "png bytes please");
  fire("studio-copy", { length: 10 });
  fire("studio-copy", null);
  assert.strictEqual(calls.clipboardImages + calls.clipboardText, before,
    "a non-binary payload reached the clipboard");
  fire("studio-copy", new Uint8Array([1, 2, 3]));
  assert.ok(calls.clipboardImages + calls.clipboardText > before, "a valid payload was dropped");
});

test("a malformed capture region is dropped without a crash", async () => {
  const cb = calls.ipcOn.get("capture-region");
  for (const bad of [null, {}, { x: 0, y: 0, width: 0, height: 10, viewportWidth: 100, viewportHeight: 100 },
                     { x: NaN, y: 0, width: 10, height: 10, viewportWidth: 100, viewportHeight: 100 },
                     { x: 0, y: 0, width: 10, height: 10, viewportWidth: 0, viewportHeight: 100 }]) {
    await cb({ sender: scratchWin.webContents }, bad);
  }
});

test("the What's new link opens a release page, never an attacker-shaped URL", () => {
  calls.openedExternal.length = 0;
  // No version yet: fall back to the releases index rather than building a
  // half-formed tag URL.
  fire("update-notes");
  assert.ok(/\/releases$/.test(calls.openedExternal[0]), calls.openedExternal[0]);
  for (const u of calls.openedExternal) {
    assert.ok(u.startsWith("https://github.com/Mopra/qgn.app/releases"), "unexpected URL: " + u);
  }
});

test("the tray menu offers every entry point", () => {
  const labels = calls.trayMenus[calls.trayMenus.length - 1].map((i) => i.label).filter(Boolean);
  for (const expected of ["Capture full screen", "Open Studio", "Annotate clipboard image",
                          "Open clipboard image in Studio", "Open video in Studio...", "Settings...", "Quit"]) {
    assert.ok(labels.some((l) => l === expected), `tray menu is missing "${expected}" (has: ${labels.join(" | ")})`);
  }
});

/* ───────────────────────── Runner ───────────────────────── */
async function runMainTests() {
  let failed = 0;
  for (const { name, fn } of cases) {
    try {
      await fn();
    } catch (e) {
      failed++;
      console.error(`FAIL: ${name}\n      ${e.message}`);
    }
  }
  Module._load = originalLoad;
  try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {}
  if (!failed) console.log(`OK: ${cases.length} main-process boot test(s) passed.`);
  return failed;
}

module.exports = { runMainTests };

if (require.main === module) {
  runMainTests().then((f) => process.exit(f ? 1 : 0));
}
