/* QGN Studio: the scene engine.

   Background, frame, layout and the composite paint. Everything here works in
   source pixels and is driven entirely by `state` + the media source, so the
   live preview, the PNG export and every exported video frame go through the
   exact same code path. This file was previously duplicated between the
   screenshot and video studios. */

/* ───────────────────────── Color helpers ───────────────────────── */
function hexToRgb(hex) {
  let h = hex.replace("#", "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = parseInt(h, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
function rgba(hex, a) {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r},${g},${b},${a})`;
}
function normHex(v) {
  const s = String(v == null ? "" : v).trim();
  if (!/^#?[0-9a-fA-F]{6}$/.test(s)) return null;
  return (s.startsWith("#") ? s : "#" + s).toUpperCase();
}

/* ───────────────────────── Gradients ───────────────────────── */
// User-saved custom gradients, loaded from disk by the sidebar.
let savedGradients = [];

// The custom gradient is a live two-stop gradient driven by the editor.
function buildCustomGradient() {
  const c = state.gradientCustom;
  return { id: "custom", angle: c.angle, stops: [[0, c.c0], [1, c.c1]] };
}
// A saved gradient ({id, angle, c0, c1}) expanded to a renderable preset.
function gradientFromSaved(g) {
  return { id: g.id, angle: g.angle, stops: [[0, g.c0], [1, g.c1]] };
}
function currentGradient() {
  if (state.gradientId === "custom") return buildCustomGradient();
  const preset = GRADIENTS.find((p) => p.id === state.gradientId);
  if (preset) return preset;
  const saved = savedGradients.find((g) => g.id === state.gradientId);
  if (saved) return gradientFromSaved(saved);
  return GRADIENTS[0];
}

/* ───────────────────────── Background ───────────────────────── */
function paintBackground(ctx, w, h) {
  if (state.bgMode === "solid") {
    ctx.fillStyle = state.solidColor;
    ctx.fillRect(0, 0, w, h);
    return;
  }
  if (state.bgMode === "image" && state.customImage) {
    drawCover(ctx, state.customImage, 0, 0, w, h);
    return;
  }
  if (state.bgMode === "wallpaper") {
    const wp = WALLPAPERS.find((p) => p.id === state.wallpaperId) || WALLPAPERS[0];
    ctx.fillStyle = wp.base;
    ctx.fillRect(0, 0, w, h);
    const max = Math.max(w, h);
    ctx.save();
    ctx.globalCompositeOperation = wp.blend === "lighter" ? "lighter" : "source-over";
    for (const b of wp.blobs) {
      const cx = b.x * w, cy = b.y * h, rad = b.r * max;
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, rad);
      g.addColorStop(0, rgba(b.c, wp.blend === "lighter" ? 0.85 : 0.9));
      g.addColorStop(1, rgba(b.c, 0));
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    }
    ctx.restore();
    return;
  }
  // gradient (default)
  const gr = currentGradient();
  const rad = (gr.angle * Math.PI) / 180;
  const cx = w / 2, cy = h / 2;
  const dx = Math.cos(rad), dy = Math.sin(rad);
  const half = (Math.abs(w * dx) + Math.abs(h * dy)) / 2;
  const g = ctx.createLinearGradient(cx - dx * half, cy - dy * half, cx + dx * half, cy + dy * half);
  for (const [pos, color] of gr.stops) g.addColorStop(pos, color);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
}

// Draw an image to cover a target rect (object-fit: cover), centered.
function drawCover(ctx, img, x, y, w, h) {
  const iw = img.naturalWidth || img.width;
  const ih = img.naturalHeight || img.height;
  if (!iw || !ih) return;
  const scale = Math.max(w / iw, h / ih);
  const dw = iw * scale, dh = ih * scale;
  ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
}

/* ───────────────────────── Layout ───────────────────────── */
function layout() {
  const iw = srcW(), ih = srcH();
  const base = Math.max(iw, ih) || 1;
  const pad = state.padPct * base;
  const radius = state.radiusPct * base;
  const headerH = state.frame === "browser" ? Math.max(34, base * 0.045) : 0;
  const frameW = iw;
  const frameH = ih + headerH;
  const paddedW = frameW + pad * 2;
  const paddedH = frameH + pad * 2;
  let sceneW = paddedW, sceneH = paddedH;
  const ar = ASPECTS[state.aspect];
  if (ar) {
    if (paddedW / paddedH < ar) sceneW = paddedH * ar;
    else sceneH = paddedW / ar;
  }
  return {
    baseDim: base, pad, radius, headerH, frameW, frameH, sceneW, sceneH,
    frameX: (sceneW - frameW) / 2,
    frameY: (sceneH - frameH) / 2,
  };
}

// Top-left of the media itself inside the scene (below the browser chrome when
// one is shown). Annotations and the camera are anchored here.
function mediaOrigin(L) {
  return { x: L.frameX, y: L.frameY + (state.frame === "browser" ? L.headerH : 0) };
}

/* ───────────────────────── Browser chrome ───────────────────────── */
function drawBrowserChrome(ctx, L, dark) {
  const hY = L.frameY + L.headerH / 2;
  const dotR = Math.max(3, L.headerH * 0.11);
  const startX = L.frameX + L.headerH * 0.6;
  const gap = dotR * 3.2;
  const dotColors = ["#ff5f57", "#febc2e", "#28c840"];
  for (let i = 0; i < 3; i++) {
    ctx.beginPath();
    ctx.arc(startX + i * gap, hY, dotR, 0, Math.PI * 2);
    ctx.fillStyle = dotColors[i];
    ctx.fill();
  }

  // Address bar pill, centered.
  const pillH = L.headerH * 0.52;
  const pillW = Math.min(L.frameW * 0.55, L.frameW - (startX - L.frameX) * 2 - gap * 2);
  if (pillW > pillH) {
    const pillX = L.frameX + (L.frameW - pillW) / 2;
    const pillY = hY - pillH / 2;
    ctx.beginPath();
    ctx.roundRect(pillX, pillY, pillW, pillH, pillH / 2);
    ctx.fillStyle = dark ? "rgba(255,255,255,0.10)" : "rgba(0,0,0,0.05)";
    ctx.fill();
    if (state.url) {
      const fs = Math.min(pillH * 0.5, L.headerH * 0.3);
      ctx.font = `500 ${fs}px -apple-system, "Segoe UI", system-ui, sans-serif`;
      ctx.fillStyle = dark ? "rgba(255,255,255,0.6)" : "rgba(0,0,0,0.5)";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(state.url, pillX + pillW / 2, hY + fs * 0.05, pillW * 0.9);
      ctx.textAlign = "start";
    }
  }
}

/* ───────────────────────── Composite ─────────────────────────
   Paints the whole composition in scene pixels. The caller sets the transform
   first (uniform for the preview, near-uniform for export), so this is
   resolution-independent. */
function paintScene(ctx, L) {
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.clearRect(0, 0, L.sceneW, L.sceneH);

  paintBackground(ctx, L.sceneW, L.sceneH);

  const r = Math.min(L.radius, L.frameW / 2, L.frameH / 2);

  // Drop shadow cast by the framed media.
  if (state.shadowPct > 0) {
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,0.35)";
    ctx.shadowBlur = state.shadowPct * L.baseDim;
    ctx.shadowOffsetY = state.shadowPct * L.baseDim * 0.45;
    ctx.beginPath();
    ctx.roundRect(L.frameX, L.frameY, L.frameW, L.frameH, r);
    ctx.fillStyle = "#ffffff";
    ctx.fill();
    ctx.restore();
  }

  const t = currentTime();
  const cam = cameraAt(t);
  const m = mediaOrigin(L);
  const iw = srcW(), ih = srcH();

  // Framed content, clipped to the rounded rect.
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(L.frameX, L.frameY, L.frameW, L.frameH, r);
  ctx.clip();

  if (state.frame === "browser") {
    const dark = state.frameTheme === "dark";
    ctx.fillStyle = dark ? "#2b2b30" : "#f6f6f7";
    ctx.fillRect(L.frameX, L.frameY, L.frameW, L.headerH);
    drawBrowserChrome(ctx, L, dark);
  }

  // Only the media pixels zoom; the frame, header and border stay put.
  // Annotations ride inside the same transform because they are pinned to
  // content, not to the viewport.
  ctx.save();
  applyCameraTransform(ctx, m.x, m.y, iw, ih, cam);
  drawSource(ctx, m.x, m.y);
  drawAnnotations(ctx, m.x, m.y);
  ctx.restore();

  // Overlays sit on top at constant on-screen size, still clipped to the frame
  // so they cannot spill onto the background.
  drawRipples(ctx, t, m.x, m.y, iw, ih, cam, L.baseDim);
  drawSyntheticCursor(ctx, t, m.x, m.y, iw, ih, cam, L.baseDim);
  ctx.restore();

  // Window frames get a subtle edge so they read as a window, not a borderless
  // cutout.
  if (state.frame === "window" || state.frame === "browser") {
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(L.frameX, L.frameY, L.frameW, L.frameH, r);
    ctx.lineWidth = Math.max(1, L.baseDim * 0.0012);
    ctx.strokeStyle = "rgba(0,0,0,0.12)";
    ctx.stroke();
    ctx.restore();
  }

  // The live crop marquee is transient UI, drawn outside the frame clip so the
  // dimming can cover the padding too. It never reaches an export.
  drawCropOverlay(ctx, L);
}

function renderSceneScaled(ctx, sx, sy, L) {
  ctx.setTransform(sx, 0, 0, sy, 0, 0);
  paintScene(ctx, L);
}
