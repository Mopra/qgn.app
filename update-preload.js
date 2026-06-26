const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("updateAPI", {
  installUpdate: () => ipcRenderer.send("update-install"),
  dismiss: () => ipcRenderer.send("update-dismiss"),
  star: () => ipcRenderer.send("star-open"),
  onUpdateStatus: (callback) => {
    ipcRenderer.removeAllListeners("update-status");
    ipcRenderer.on("update-status", (_event, data) => callback(data));
  },
});
