const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("preview", {
  onShow: (cb) => ipcRenderer.on("show-preview", (_e, data) => cb(data)),
  onUpdate: (cb) => ipcRenderer.on("update-preview", (_e, data) => cb(data)),
  close: () => ipcRenderer.send("close-preview"),
  openFile: () => ipcRenderer.send("preview-open-file"),
  edit: () => ipcRenderer.send("preview-edit"),
  pin: (pinned) => ipcRenderer.send("preview-pin", pinned),
  getBounds: () => ipcRenderer.invoke("preview-get-bounds"),
  setBounds: (bounds) => ipcRenderer.send("preview-set-bounds", bounds),
});
