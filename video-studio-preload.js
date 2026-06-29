const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("videoStudio", {
  // Main sends the source recording's bytes + mime type once on open.
  onLoad: (cb) => {
    ipcRenderer.removeAllListeners("load-video");
    ipcRenderer.on("load-video", (_e, data) => cb(data));
  },

  // Export a finished mp4/webm (real-time MediaRecorder output).
  exportEncoded: (bytes, thumbnailDataUrl, format) =>
    ipcRenderer.send("vstudio-save-encoded", { bytes, thumbnailDataUrl, format }),

  // Export an animated gif/webp from a sequence of PNG frames; main assembles
  // them with sharp.
  exportFrames: (payload) => ipcRenderer.send("vstudio-save-frames", payload),

  // Main signals the outcome of an export so the renderer can close or recover.
  onExportDone: (cb) => {
    ipcRenderer.removeAllListeners("vstudio-export-done");
    ipcRenderer.on("vstudio-export-done", () => cb());
  },
  onExportError: (cb) => {
    ipcRenderer.removeAllListeners("vstudio-export-error");
    ipcRenderer.on("vstudio-export-error", (_e, message) => cb(message));
  },

  cancel: () => ipcRenderer.send("vstudio-cancel"),

  // Saved color/gradient palettes are shared with the screenshot Studio, so we
  // reuse its IPC channels rather than maintaining a second palette.
  getColors: () => ipcRenderer.invoke("studio-get-colors"),
  saveColors: (colors) => ipcRenderer.send("studio-save-colors", colors),
  getGradients: () => ipcRenderer.invoke("studio-get-gradients"),
  saveGradients: (gradients) => ipcRenderer.send("studio-save-gradients", gradients),
});
