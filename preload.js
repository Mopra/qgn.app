const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("qgn", {
  captureRegion: (region) => ipcRenderer.send("capture-region", region),
  startVideoRecording: (region) =>
    ipcRenderer.send("start-video-recording", region),
  cancel: () => ipcRenderer.send("cancel"),
  // A small crop of the already-captured frame around the cursor, for the
  // pixel loupe. Sending crops on demand keeps the full screenshot in the main
  // process instead of shipping it to the renderer on every activation.
  magnify: (req) => ipcRenderer.invoke("overlay-magnify", req),
  // Window rectangles for snapping, in CSS pixels relative to this display.
  // Resolves to [] wherever the platform can't supply them.
  getWindowRects: () => ipcRenderer.invoke("overlay-window-rects"),
  onActivateCapture: (cb) => {
    ipcRenderer.removeAllListeners("activate-capture");
    ipcRenderer.on("activate-capture", (_e, data) => cb(data));
  },
  onClear: (cb) => {
    ipcRenderer.removeAllListeners("overlay-clear");
    ipcRenderer.on("overlay-clear", () => cb());
  },
  onResetForVideo: (cb) => {
    ipcRenderer.removeAllListeners("overlay-reset-video");
    ipcRenderer.on("overlay-reset-video", (_e, data) => cb(data));
  },
  onShowRecordingBorder: (cb) => {
    ipcRenderer.removeAllListeners("overlay-show-rec-border");
    ipcRenderer.on("overlay-show-rec-border", (_e, data) => cb(data));
  },
  onHideRecordingBorder: (cb) => {
    ipcRenderer.removeAllListeners("overlay-hide-rec-border");
    ipcRenderer.on("overlay-hide-rec-border", () => cb());
  },
  closeMicDropdown: () => ipcRenderer.send("close-mic-dropdown"),
});
