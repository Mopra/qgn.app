const fs = require("fs");
const path = require("path");

const svgPath = path.join(__dirname, "..", "qgn logo.svg");
const svg = fs.readFileSync(svgPath, "utf-8");

// --- Parse rects ---
const rectRegex =
  /<rect\s+x="([^"]+)"\s+y="([^"]+)"\s+width="([^"]+)"\s+height="([^"]+)"\s+fill="([^"]+)"\/>/g;
const rects = [];
let m;
while ((m = rectRegex.exec(svg)) !== null) {
  rects.push({ x: +m[1], y: +m[2], w: +m[3], h: +m[4], fill: m[5] });
}
if (!rects.length) {
  console.error("No rects found");
  process.exit(1);
}

const fill = rects[0].fill;
console.log(`Parsed ${rects.length} rects, fill=${fill}`);

// --- Determine grid from rect coordinates ---
const ys = [...new Set(rects.map((r) => +r.y.toFixed(2)))].sort(
  (a, b) => a - b
);
const step = +(ys[1] - ys[0]).toFixed(4);
const ox = Math.min(...rects.map((r) => r.x));
const oy = ys[0];
const maxX = Math.max(...rects.map((r) => r.x + r.w));

const rows = ys.length;
const cols = Math.round((maxX - ox) / step);
console.log(
  `Grid: ${cols}x${rows}, step=${step}, origin=(${ox.toFixed(2)},${oy.toFixed(2)})`
);

// Build boolean grid
const grid = Array.from({ length: rows }, () => new Uint8Array(cols));
for (const r of rects) {
  const row = Math.round((r.y - oy) / step);
  const c0 = Math.round((r.x - ox) / step);
  const cn = Math.round(r.w / step);
  for (let c = c0; c < c0 + cn && c < cols; c++) {
    if (row >= 0 && row < rows && c >= 0) grid[row][c] = 1;
  }
}

// --- Contour tracing ---
// Directions: 0=right, 1=down, 2=left, 3=up
const DX = [1, 0, -1, 0];
const DY = [0, 1, 0, -1];

// For clockwise traversal in direction d, the filled/empty cell offsets from vertex (vx,vy):
const FC = [
  [0, 0],
  [-1, 0],
  [-1, -1],
  [0, -1],
];
const EC = [
  [0, -1],
  [0, 0],
  [-1, 0],
  [-1, -1],
];

function ok(cx, cy) {
  return cx >= 0 && cx < cols && cy >= 0 && cy < rows && grid[cy][cx] === 1;
}

function validEdge(vx, vy, d) {
  return (
    ok(vx + FC[d][0], vy + FC[d][1]) && !ok(vx + EC[d][0], vy + EC[d][1])
  );
}

function nextD(vx, vy, prev) {
  // Priority: right turn, straight, left turn, u-turn
  for (const d of [(prev + 1) % 4, prev, (prev + 3) % 4, (prev + 2) % 4]) {
    if (validEdge(vx, vy, d)) return d;
  }
  return -1;
}

const used = new Set();
const ek = (vx, vy, d) => `${vx},${vy},${d}`;

function trace(sx, sy, sd) {
  const pts = [{ x: sx, y: sy }];
  used.add(ek(sx, sy, sd));

  let vx = sx + DX[sd];
  let vy = sy + DY[sd];
  let pd = sd;

  for (let i = 0; i < 2000000; i++) {
    const d = nextD(vx, vy, pd);
    if (d === -1) break;

    const k = ek(vx, vy, d);
    if (used.has(k)) break;

    if (d !== pd) pts.push({ x: vx, y: vy });
    used.add(k);

    pd = d;
    vx += DX[d];
    vy += DY[d];
  }

  return pts;
}

// Remove collinear midpoints
function simplify(pts) {
  if (pts.length < 3) return pts;
  const n = pts.length;
  return pts.filter((p, i) => {
    const prev = pts[(i - 1 + n) % n];
    const next = pts[(i + 1) % n];
    const colX = prev.x === p.x && p.x === next.x;
    const colY = prev.y === p.y && p.y === next.y;
    return !colX && !colY;
  });
}

// Find all contour loops
const loops = [];
for (let cy = 0; cy < rows; cy++) {
  for (let cx = 0; cx < cols; cx++) {
    if (!grid[cy][cx]) continue;

    // Top edge → rightward from vertex (cx, cy)
    if (!ok(cx, cy - 1) && !used.has(ek(cx, cy, 0)))
      loops.push(trace(cx, cy, 0));
    // Right edge → downward from vertex (cx+1, cy)
    if (!ok(cx + 1, cy) && !used.has(ek(cx + 1, cy, 1)))
      loops.push(trace(cx + 1, cy, 1));
    // Bottom edge → leftward from vertex (cx+1, cy+1)
    if (!ok(cx, cy + 1) && !used.has(ek(cx + 1, cy + 1, 2)))
      loops.push(trace(cx + 1, cy + 1, 2));
    // Left edge → upward from vertex (cx, cy+1)
    if (!ok(cx - 1, cy) && !used.has(ek(cx, cy + 1, 3)))
      loops.push(trace(cx, cy + 1, 3));
  }
}
console.log(`Traced ${loops.length} contour(s)`);

// --- Build SVG path data ---
const svgX = (gx) => +(gx * step + ox).toFixed(2);
const svgY = (gy) => +(gy * step + oy).toFixed(2);

let pathD = "";
for (let loop of loops) {
  loop = simplify(loop);
  if (loop.length < 3) continue;

  const f = loop[0];
  pathD += `M${svgX(f.x)},${svgY(f.y)}`;
  for (let i = 1; i < loop.length; i++) {
    const p = loop[i];
    const prev = loop[i - 1];
    pathD += p.y === prev.y ? `H${svgX(p.x)}` : `V${svgY(p.y)}`;
  }
  pathD += "Z";
}

// --- Write clean SVG ---
const out = [
  '<svg xmlns="http://www.w3.org/2000/svg" width="2048" height="1365" viewBox="0 0 2048 1365">',
  `<path d="${pathD}" fill="${fill}"/>`,
  "</svg>",
].join("\n");

fs.writeFileSync(svgPath, out, "utf-8");

const oldSize = Buffer.byteLength(svg);
const newSize = Buffer.byteLength(out);
console.log(
  `Size: ${oldSize} → ${newSize} bytes (${((1 - newSize / oldSize) * 100).toFixed(1)}% smaller)`
);
