const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("annotate", {
  onLoad: (cb) => ipcRenderer.on("load-image", (_e, data) => cb(data)),
  save: (pngBuffer) => ipcRenderer.send("annotation-save", pngBuffer),
  cancel: () => ipcRenderer.send("annotation-cancel"),
});
