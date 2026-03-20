const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("updateAPI", {
  installUpdate: () => ipcRenderer.send("update-install"),
  dismiss: () => ipcRenderer.send("update-dismiss"),
  onUpdateStatus: (callback) => ipcRenderer.on("update-status", (_event, data) => callback(data)),
});
