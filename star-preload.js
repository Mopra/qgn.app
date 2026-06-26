const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("starAPI", {
  star: () => ipcRenderer.send("star-open"),
  dismiss: () => ipcRenderer.send("star-dismiss"),
});
