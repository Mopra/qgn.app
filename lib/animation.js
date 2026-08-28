// Assemble a sequence of PNG frames into an animated GIF or WebP.
//
// libvips (behind sharp) represents an animation as a single tall image: every
// frame stacked vertically, with `pageHeight` telling it where one frame ends
// and the next begins. So the job is to decode each PNG to raw RGBA at exactly
// the target size and write it into one preallocated strip.
//
// Split out of main.js so the export path can be tested directly rather than
// only through a live render.

// Raw RGBA the main process is willing to hold while assembling. Studio scales
// its export plan to fit; this is the hard backstop that keeps a bad payload
// from taking the whole app down. Kept in sync with ANIM_RAW_BUDGET in
// studio/presets.js.
const RAW_BUDGET_BYTES = 384 * 1024 * 1024;
const MAX_FRAMES = 1200;
const MAX_DIM = 4096;
const MIN_DELAY_MS = 20;
const DEFAULT_DELAY_MS = 66;

// Every failure returns the same shape, so the caller has one path for "show
// the user something useful" and one for the log.
function fail(reason, userMessage) {
  return { ok: false, reason, userMessage: userMessage || "Couldn't render the animation." };
}

async function assembleAnimation(payload) {
  const { frames, delays, width, height, format } = payload || {};
  const isWebp = format === "webp";
  if (format !== "gif" && !isWebp) return fail("bad format");
  if (!Array.isArray(frames) || frames.length === 0) return fail("no frames");
  if (frames.length > MAX_FRAMES) {
    return fail(`too many frames (${frames.length})`,
      "That animation is too long to render. Trim the clip and try again.");
  }

  const w = Math.round(Number(width));
  const h = Math.round(Number(height));
  if (!(w > 0 && h > 0 && w <= MAX_DIM && h <= MAX_DIM)) return fail("bad dimensions");

  const expected = w * h * 4;
  if (expected * frames.length > RAW_BUDGET_BYTES) {
    return fail("over the raw memory budget",
      "That animation is too large to render. Trim the clip and try again.");
  }

  const sharp = require("sharp");
  // One preallocated strip: collecting per-frame buffers and concatenating them
  // afterwards would hold two full copies at once, which is where a long GIF
  // used to run the process out of memory.
  const strip = Buffer.allocUnsafe(expected * frames.length);
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    if (!(f instanceof Uint8Array) && !Buffer.isBuffer(f)) return fail("frame " + i + " is not binary");
    let raw;
    try {
      raw = await sharp(Buffer.from(f)).resize(w, h, { fit: "fill" }).ensureAlpha().raw().toBuffer();
    } catch (e) {
      return fail("frame " + i + " failed to decode: " + (e && e.message));
    }
    if (raw.length !== expected) return fail("frame " + i + " size mismatch");
    raw.copy(strip, i * expected);
  }

  const delayArr = Array.isArray(delays) && delays.length === frames.length
    ? delays.map((d) => Math.max(MIN_DELAY_MS, Math.round(Number(d) || DEFAULT_DELAY_MS)))
    : frames.map(() => DEFAULT_DELAY_MS);

  try {
    const pipeline = sharp(strip, {
      raw: { width: w, height: h * frames.length, channels: 4, pageHeight: h },
    });
    const buffer = isWebp
      ? await pipeline.webp({ delay: delayArr, loop: 0, quality: 80, effort: 4 }).toBuffer()
      : await pipeline.gif({ delay: delayArr, loop: 0 }).toBuffer();
    return { ok: true, buffer, ext: isWebp ? "webp" : "gif" };
  } catch (e) {
    return fail("encode failed: " + (e && e.message));
  }
}

module.exports = { assembleAnimation, RAW_BUDGET_BYTES, MAX_FRAMES, MAX_DIM };
