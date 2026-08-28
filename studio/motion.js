/* QGN Studio motion: the zoom camera, the smoothed cursor track, and the
   overlays they drive.

   Everything here is a PURE function of a time `t`. That is what makes the
   real-time export and the frame-stepped gif/webp export render identically to
   the live preview. For a still image every one of these is a no-op: there are
   no zoom segments, no cursor table and no clicks, so the camera is identity
   and the overlays draw nothing. */

function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
function smoothstep(p) { p = clamp01(p); return p * p * (3 - 2 * p); }

// Keep focus within bounds that guarantee the zoomed media still fully covers
// the frame (no background bleed) at the given scale.
function clampFocus(c, scale) {
  if (scale <= 1) return 0.5;
  const half = 0.5 / scale;
  return Math.max(half, Math.min(1 - half, c));
}

// Blend from identity toward the active zoom segment with eased ends.
function cameraAt(t) {
  const segs = state.zoomSegments;
  if (!segs || !segs.length) return { scale: 1, cx: 0.5, cy: 0.5 };
  // Last-starting segment that contains t wins (defensive vs overlaps).
  let seg = null;
  for (let i = segs.length - 1; i >= 0; i--) {
    if (t >= segs[i].startT && t <= segs[i].endT) { seg = segs[i]; break; }
  }
  if (!seg) return { scale: 1, cx: 0.5, cy: 0.5 };
  const easeIn = Math.max(0.001, seg.easeIn || 0.001);
  const easeOut = Math.max(0.001, seg.easeOut || 0.001);
  let w = 1;
  if (t < seg.startT + easeIn) w = smoothstep((t - seg.startT) / easeIn);
  else if (t > seg.endT - easeOut) w = smoothstep((seg.endT - t) / easeOut);
  const scale = 1 + (seg.scale - 1) * w;
  const cx = 0.5 + (clampFocus(seg.cx, seg.scale) - 0.5) * w;
  const cy = 0.5 + (clampFocus(seg.cy, seg.scale) - 0.5) * w;
  return { scale, cx: clampFocus(cx, scale), cy: clampFocus(cy, scale) };
}

// Scale the media layer about the focus point, in source pixel space.
// (vx,vy) is the media top-left; iw,ih its visible size.
function applyCameraTransform(ctx, vx, vy, iw, ih, cam) {
  if (cam.scale === 1) return;
  const fx = vx + cam.cx * iw;
  const fy = vy + cam.cy * ih;
  ctx.translate(fx, fy);
  ctx.scale(cam.scale, cam.scale);
  ctx.translate(-fx, -fy);
}

// Map a normalized media point [0..1] through the camera to scene coords, so
// overlays (cursor, ripple) sit at the right on-screen spot while being drawn
// at constant size (that is, NOT scaled by the zoom).
function cameraMapPoint(nx, ny, vx, vy, iw, ih, cam) {
  const fx = vx + cam.cx * iw, fy = vy + cam.cy * ih;
  return {
    x: fx + (vx + nx * iw - fx) * cam.scale,
    y: fy + (vy + ny * ih - fy) * cam.scale,
  };
}
// Inverse: a scene point back to source pixels under the current camera.
function sceneToSourcePoint(sx, sy, vx, vy, iw, ih, cam) {
  const fx = vx + cam.cx * iw, fy = vy + cam.cy * ih;
  const px = fx + (sx - fx) / cam.scale;
  const py = fy + (sy - fy) / cam.scale;
  return { x: px - vx, y: py - vy };
}

/* ── Smoothed cursor position table (deterministic, indexed by time) ── */
let cursorTable = null; // { dt, n, xs:Float32Array, ys:Float32Array } | null
let motionClicks = [];  // cached "down" events, so the per-frame ripple loop
                        // does not rescan the full event stream

function buildCursorTable(motionData, dur) {
  cursorTable = null;
  motionClicks = motionData && Array.isArray(motionData.events)
    ? motionData.events.filter((e) => e.type === "down" && typeof e.x === "number")
    : [];
  if (!motionData || !Array.isArray(motionData.events) || dur <= 0) return;
  const pts = motionData.events
    .filter((e) => (e.type === "move" || e.type === "down" || e.type === "up") &&
                   typeof e.x === "number" && typeof e.y === "number")
    .sort((a, b) => a.t - b.t);
  if (pts.length === 0) return;
  const dt = CURSOR_GRID_DT;
  const n = Math.max(2, Math.ceil(dur / dt) + 1);
  const rawX = new Float32Array(n), rawY = new Float32Array(n);
  // Resample event points onto the fixed grid by linear interpolation, holding
  // the first/last value beyond the ends.
  let j = 0;
  for (let i = 0; i < n; i++) {
    const t = i * dt;
    while (j < pts.length - 1 && pts[j + 1].t <= t) j++;
    const a = pts[j], b = pts[Math.min(j + 1, pts.length - 1)];
    if (b === a || b.t <= a.t) { rawX[i] = a.x; rawY[i] = a.y; }
    else {
      const f = clamp01((t - a.t) / (b.t - a.t));
      rawX[i] = a.x + (b.x - a.x) * f;
      rawY[i] = a.y + (b.y - a.y) * f;
    }
  }
  // Zero-phase EMA smoothing: forward then backward pass over the grid.
  const alpha = 1 - Math.exp(-dt / CURSOR_SMOOTH_TAU);
  const xs = new Float32Array(n), ys = new Float32Array(n);
  let sx = rawX[0], sy = rawY[0];
  for (let i = 0; i < n; i++) { sx += alpha * (rawX[i] - sx); sy += alpha * (rawY[i] - sy); xs[i] = sx; ys[i] = sy; }
  sx = xs[n - 1]; sy = ys[n - 1];
  for (let i = n - 1; i >= 0; i--) { sx += alpha * (xs[i] - sx); sy += alpha * (ys[i] - sy); xs[i] = sx; ys[i] = sy; }
  cursorTable = { dt, n, xs, ys };
}

function cursorAt(t) {
  if (!cursorTable) return null;
  const { dt, n, xs, ys } = cursorTable;
  const g = t / dt;
  if (g <= 0) return { x: xs[0], y: ys[0] };
  if (g >= n - 1) return { x: xs[n - 1], y: ys[n - 1] };
  const i = Math.floor(g), f = g - i;
  return { x: xs[i] + (xs[i + 1] - xs[i]) * f, y: ys[i] + (ys[i + 1] - ys[i]) * f };
}

function resetCursorTable() {
  cursorTable = null;
  motionClicks = [];
}

/* ── Auto-zoom generation from click events (pure) ── */
let zoomSeq = 0;
function zoomUid() { return "z" + (zoomSeq++).toString(36) + "-" + Math.round(state.trimOut * 1000); }

function generateAutoZoom(motionData, dur) {
  if (!motionData || !Array.isArray(motionData.events) || dur <= 0) return [];
  const clicks = motionData.events
    .filter((e) => e.type === "down" && typeof e.x === "number")
    .sort((a, b) => a.t - b.t);
  if (!clicks.length) return [];
  // Cluster clicks that are close in time.
  const clusters = [];
  let cur = [clicks[0]];
  for (let i = 1; i < clicks.length; i++) {
    if (clicks[i].t - cur[cur.length - 1].t <= AUTOZOOM.CLUSTER_GAP) cur.push(clicks[i]);
    else { clusters.push(cur); cur = [clicks[i]]; }
  }
  clusters.push(cur);
  // Build a candidate segment per cluster.
  const segs = clusters.map((cl) => {
    const cx = cl.reduce((s, c) => s + c.x, 0) / cl.length;
    const cy = cl.reduce((s, c) => s + c.y, 0) / cl.length;
    let minX = 1, maxX = 0, minY = 1, maxY = 0;
    for (const c of cl) { minX = Math.min(minX, c.x); maxX = Math.max(maxX, c.x); minY = Math.min(minY, c.y); maxY = Math.max(maxY, c.y); }
    const spread = Math.max(maxX - minX, maxY - minY, 0.05);
    // Widely-spread clicks zoom less so all stay in view.
    const scale = Math.max(AUTOZOOM.MIN_SCALE, Math.min(AUTOZOOM.SCALE, 0.9 / spread));
    const startT = Math.max(0, cl[0].t - AUTOZOOM.LEAD);
    const endT = Math.min(dur, cl[cl.length - 1].t + AUTOZOOM.DWELL);
    return { startT, endT, cx: clampFocus(cx, scale), cy: clampFocus(cy, scale), scale };
  });
  // Merge near-overlapping segments.
  const merged = [];
  for (const s of segs) {
    const prev = merged[merged.length - 1];
    if (prev && s.startT - prev.endT <= AUTOZOOM.MERGE_GAP) {
      prev.endT = Math.max(prev.endT, s.endT);
      const ns = Math.min(prev.scale, s.scale);
      prev.cx = clampFocus((prev.cx + s.cx) / 2, ns);
      prev.cy = clampFocus((prev.cy + s.cy) / 2, ns);
      prev.scale = ns;
    } else merged.push({ ...s });
  }
  return merged
    .filter((s) => s.endT - s.startT >= AUTOZOOM.MIN_LEN)
    .map((s) => {
      const len = s.endT - s.startT;
      return {
        id: zoomUid(),
        startT: s.startT, endT: s.endT,
        cx: s.cx, cy: s.cy, scale: +s.scale.toFixed(2),
        easeIn: Math.min(0.4, len * 0.3),
        easeOut: Math.min(0.5, len * 0.35),
        source: "auto",
      };
    });
}

/* ── Overlay drawing: click ripples + synthetic cursor ── */
function drawRipples(ctx, t, vx, vy, iw, ih, cam, base) {
  if (!state.cursor.ripple || !motionClicks.length) return;
  for (let i = 0; i < motionClicks.length; i++) {
    const e = motionClicks[i];
    const age = (t - e.t) / RIPPLE_DUR;
    if (age < 0 || age >= 1) continue;
    const p = cameraMapPoint(e.x, e.y, vx, vy, iw, ih, cam);
    const R = base * 0.02 + age * base * 0.06;
    ctx.save();
    ctx.beginPath();
    ctx.arc(p.x, p.y, R, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(255,255,255,${(1 - age) * 0.55})`;
    ctx.lineWidth = Math.max(1, base * 0.004);
    ctx.stroke();
    ctx.restore();
  }
}

function drawSyntheticCursor(ctx, t, vx, vy, iw, ih, cam, base) {
  if (!state.cursor.enabled) return;
  const c = cursorAt(t);
  if (!c) return;
  const p = cameraMapPoint(c.x, c.y, vx, vy, iw, ih, cam);
  const s = base * 0.03 * (state.cursor.size || 1);
  const col = state.cursor.color || "#ffffff";
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.45)";
  ctx.shadowBlur = s * 0.5;
  ctx.shadowOffsetY = s * 0.08;
  if (state.cursor.style === "dot") {
    ctx.beginPath();
    ctx.arc(p.x, p.y, s * 0.5, 0, Math.PI * 2);
    ctx.fillStyle = col; ctx.fill();
    ctx.lineWidth = Math.max(1, s * 0.09); ctx.strokeStyle = "rgba(0,0,0,0.5)"; ctx.stroke();
  } else if (state.cursor.style === "ring") {
    ctx.beginPath();
    ctx.arc(p.x, p.y, s * 0.5, 0, Math.PI * 2);
    ctx.lineWidth = Math.max(1.5, s * 0.16); ctx.strokeStyle = col; ctx.stroke();
  } else {
    // Classic arrow pointer; hotspot at the tip (p.x, p.y).
    ctx.translate(p.x, p.y);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(0, s * 1.25);
    ctx.lineTo(s * 0.32, s * 0.92);
    ctx.lineTo(s * 0.52, s * 1.34);
    ctx.lineTo(s * 0.7, s * 1.26);
    ctx.lineTo(s * 0.5, s * 0.84);
    ctx.lineTo(s * 0.92, s * 0.84);
    ctx.closePath();
    ctx.fillStyle = col; ctx.fill();
    ctx.lineWidth = Math.max(1, s * 0.08); ctx.strokeStyle = "rgba(0,0,0,0.55)"; ctx.stroke();
  }
  ctx.restore();
}
