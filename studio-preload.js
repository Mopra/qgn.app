const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("studio", {
  onLoad: (cb) => {
    ipcRenderer.removeAllListeners("load-image");
    ipcRenderer.on("load-image", (_e, data) => cb(data));
  },
  save: (pngBuffer) => ipcRenderer.send("studio-save", pngBuffer),
  copy: (pngBuffer) => ipcRenderer.send("studio-copy", pngBuffer),
  cancel: () => ipcRenderer.send("studio-cancel"),
  getColors: () => ipcRenderer.invoke("studio-get-colors"),
  saveColors: (colors) => ipcRenderer.send("studio-save-colors", colors),
  getGradients: () => ipcRenderer.invoke("studio-get-gradients"),
  saveGradients: (gradients) => ipcRenderer.send("studio-save-gradients", gradients),
});
