const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("qgn", {
  capture: (pngBuffer) => ipcRenderer.send("capture", pngBuffer),
  startVideoRecording: (region) =>
    ipcRenderer.send("start-video-recording", region),
  cancel: () => ipcRenderer.send("cancel"),
  getSources: () => ipcRenderer.invoke("get-sources"),
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
    ipcRenderer.on("overlay-reset-video", () => cb());
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
