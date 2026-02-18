const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("qgn", {
  capture: (region) => ipcRenderer.send("capture", region),
  cancel: () => ipcRenderer.send("cancel"),
});
