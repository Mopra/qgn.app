const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("qgnDropdown", {
  getSelectedMicId: () => ipcRenderer.invoke("get-selected-mic-id"),
  selectDevice: (deviceId) => ipcRenderer.send("mic-device-selected", deviceId),
  onRefresh: (cb) => ipcRenderer.on("refresh-devices", () => cb()),
});
