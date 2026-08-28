const { contextBridge, ipcRenderer } = require("electron");

// One bridge for the whole Studio: stills, clips and markup all run in the same
// window, so they share a single API surface.
contextBridge.exposeInMainWorld("studio", {
  // Main sends the source once on open: either { kind:"image", imageDataUrl }
  // or { kind:"video", videoBytes, mimeType, motion }, plus the editor mode.
  onLoad: (cb) => {
    ipcRenderer.removeAllListeners("studio-load");
    ipcRenderer.on("studio-load", (_e, data) => cb(data));
  },

  // ── Still output ──
  copy: (pngBuffer) => ipcRenderer.send("studio-copy", pngBuffer),
  // A new capture (composed scene, new dimensions).
  save: (pngBuffer) => ipcRenderer.send("studio-save", pngBuffer),
  // Markup mode: write the edited pixels back over the original.
  overwrite: (pngBuffer) => ipcRenderer.send("studio-overwrite", pngBuffer),

  // ── Clip output ──
  // A finished mp4/webm from the renderer's MediaRecorder.
  exportEncoded: (bytes, thumbnailDataUrl, format) =>
    ipcRenderer.send("studio-export-encoded", { bytes, thumbnailDataUrl, format }),
  // A sequence of PNG frames for main to assemble into a gif/webp with sharp.
  exportFrames: (payload) => ipcRenderer.send("studio-export-frames", payload),
  onExportError: (cb) => {
    ipcRenderer.removeAllListeners("studio-export-error");
    ipcRenderer.on("studio-export-error", (_e, message) => cb(message));
  },

  cancel: () => ipcRenderer.send("studio-cancel"),

  // Markup windows float above other apps; compose windows don't.
  setAlwaysOnTop: (flag) => ipcRenderer.send("studio-set-always-on-top", !!flag),

  // ── Saved palettes (shared across every Studio window) ──
  getColors: () => ipcRenderer.invoke("studio-get-colors"),
  saveColors: (colors) => ipcRenderer.send("studio-save-colors", colors),
  getGradients: () => ipcRenderer.invoke("studio-get-gradients"),
  saveGradients: (gradients) => ipcRenderer.send("studio-save-gradients", gradients),
});
