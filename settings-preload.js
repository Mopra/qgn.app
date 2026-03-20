const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("qgnSettings", {
  getSettings: () => ipcRenderer.invoke("get-settings"),
  setCopyFormat: (fmt) => ipcRenderer.send("set-copy-format", fmt),
  setSaveToDisk: (value) => ipcRenderer.send("set-save-to-disk", value),
  chooseSaveFolder: () => ipcRenderer.send("choose-save-folder"),
  setHotkey: (action, accelerator) => ipcRenderer.send("set-hotkey", { action, accelerator }),
  onUpdated: (cb) => ipcRenderer.on("settings-updated", (_e, data) => cb(data)),
});
