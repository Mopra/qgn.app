const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("qgnRecord", {
  onStartRecording: (callback) => {
    ipcRenderer.removeAllListeners("start-recording");
    ipcRenderer.on("start-recording", (_e, data) => callback(data));
  },
  onStopRecording: (callback) => {
    ipcRenderer.removeAllListeners("stop-recording");
    ipcRenderer.on("stop-recording", () => callback());
  },
  saveRecording: (buffer, thumbnail, format) => ipcRenderer.send("save-recording", buffer, thumbnail, format),
  reportError: (message) => ipcRenderer.send("recording-error", message),
  // The bar grows when it has to carry a warning badge.
  requestWidth: (width) => ipcRenderer.send("record-bar-width", width),
  cancel: () => ipcRenderer.send("cancel"),
  // Motion-capture clock sync: align main's event timestamps to the video clock.
  motionStarted: (startTime) => ipcRenderer.send("recording-started", startTime),
  motionPaused: () => ipcRenderer.send("recording-paused"),
  motionResumed: () => ipcRenderer.send("recording-resumed"),
  openMicDropdown: () => ipcRenderer.send("open-mic-dropdown"),
  onMicDeviceSelected: (callback) => {
    ipcRenderer.removeAllListeners("mic-device-selected");
    ipcRenderer.on("mic-device-selected", (_e, deviceId) => callback(deviceId));
  },
});
