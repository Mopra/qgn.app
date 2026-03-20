const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("qgn", {
  capture: (pngBuffer) => ipcRenderer.send("capture", pngBuffer),
  startVideoRecording: (region) =>
    ipcRenderer.send("start-video-recording", region),
  cancel: () => ipcRenderer.send("cancel"),
  getSources: () => ipcRenderer.invoke("get-sources"),
  onActivateCapture: (cb) =>
    ipcRenderer.on("activate-capture", (_e, data) => cb(data)),
  closeMicDropdown: () => ipcRenderer.send("close-mic-dropdown"),
});
