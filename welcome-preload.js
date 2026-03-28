const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("welcomeAPI", {
  close: () => ipcRenderer.send("welcome-close"),
  getHotkeys: () => ipcRenderer.invoke("get-welcome-hotkeys"),
  openSettings: () => ipcRenderer.send("welcome-open-settings"),
});
