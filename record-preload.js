const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("qgnRecord", {
  onStartRecording: (callback) =>
    ipcRenderer.on("start-recording", (_e, data) => callback(data)),
  onStopRecording: (callback) =>
    ipcRenderer.on("stop-recording", () => callback()),
  saveRecording: (buffer, thumbnail, format) => ipcRenderer.send("save-recording", buffer, thumbnail, format),
  openMicDropdown: () => ipcRenderer.send("open-mic-dropdown"),
  onMicDeviceSelected: (callback) =>
    ipcRenderer.on("mic-device-selected", (_e, deviceId) => callback(deviceId)),
});
