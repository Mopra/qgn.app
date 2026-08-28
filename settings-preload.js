const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("qgnSettings", {
  getSettings: () => ipcRenderer.invoke("get-settings"),
  setCopyFormat: (fmt) => ipcRenderer.send("set-copy-format", fmt),
  setSaveToDisk: (value) => ipcRenderer.send("set-save-to-disk", value),
  chooseSaveFolder: () => ipcRenderer.send("choose-save-folder"),
  openSaveFolder: () => ipcRenderer.send("open-save-folder"),
  setStartOnStartup: (value) => ipcRenderer.send("set-start-on-startup", value),
  setImageQuality: (value) => ipcRenderer.send("set-image-quality", value),
  setDismissSeconds: (value) => ipcRenderer.send("set-dismiss-seconds", value),
  setRecordCountdown: (value) => ipcRenderer.send("set-record-countdown", value),
  setConfirmSelection: (value) => ipcRenderer.send("set-confirm-selection", value),
  setKeepHistory: (value) => ipcRenderer.send("set-keep-history", value),
  setHotkey: (action, accelerator) => ipcRenderer.send("set-hotkey", { action, accelerator }),
  resetHotkeys: () => ipcRenderer.send("reset-hotkeys"),
  resize: (height) => ipcRenderer.send("settings-resize", height),
  onHotkeyError: (cb) => {
    ipcRenderer.removeAllListeners("hotkey-error");
    ipcRenderer.on("hotkey-error", (_e, data) => cb(data));
  },
  onUpdated: (cb) => {
    ipcRenderer.removeAllListeners("settings-updated");
    ipcRenderer.on("settings-updated", (_e, data) => cb(data));
  },
});
