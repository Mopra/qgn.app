// What kind of file a capture is, and what Studio can do with it.
//
// The distinction that matters: an animated GIF or WebP exported from Studio is
// video-ish (it gets the same preview card and play badge as a recording) but a
// <video> element cannot decode one, so Studio must not offer to reopen it.

const path = require("path");

// Containers Studio's <video> element can actually decode.
const STUDIO_VIDEO_EXTS = new Set(["mp4", "webm", "mov", "mkv", "m4v"]);

function fileExt(filePath) {
  return path.extname(filePath || "").slice(1).toLowerCase();
}

// MIME type for the renderer's Blob/<video>, from the file extension.
function videoMimeForPath(filePath) {
  const ext = fileExt(filePath);
  if (ext === "webm") return "video/webm";
  if (ext === "mov") return "video/quicktime";
  if (ext === "mkv") return "video/x-matroska";
  return "video/mp4";
}

function isPlayableVideoPath(filePath) {
  return STUDIO_VIDEO_EXTS.has(fileExt(filePath));
}

// Can this capture be reopened in Studio? Stills always can; clips only when
// the file is a container Studio can decode.
function canOpenInStudio(entry) {
  if (!entry) return false;
  if (!entry.isVideo) return true;
  return isPlayableVideoPath(entry.filePath);
}

module.exports = { STUDIO_VIDEO_EXTS, fileExt, videoMimeForPath, isPlayableVideoPath, canOpenInStudio };
