const fs = require("fs");
const path = require("path");

const svgPath = path.join(__dirname, "..", "qgn logo.svg");
const svg = fs.readFileSync(svgPath, "utf-8");

// Parse all rects (skip any background rect)
const rectRegex = /<rect\s+x="([^"]+)"\s+y="([^"]+)"\s+width="([^"]+)"\s+height="([^"]+)"\s+fill="([^"]+)"\/>/g;

const rects = [];
let match;
while ((match = rectRegex.exec(svg)) !== null) {
  const [, x, y, w, h, fill] = match;
  rects.push({
    x: parseFloat(x),
    y: parseFloat(y),
    w: parseFloat(w),
    h: parseFloat(h),
    fill,
  });
}

// Find bounding box of all content rects
let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
for (const r of rects) {
  minX = Math.min(minX, r.x);
  minY = Math.min(minY, r.y);
  maxX = Math.max(maxX, r.x + r.w);
  maxY = Math.max(maxY, r.y + r.h);
}

const contentW = maxX - minX;
const contentH = maxY - minY;

console.log(`Content bounds: (${minX},${minY}) to (${maxX},${maxY})`);
console.log(`Content size: ${contentW} x ${contentH}`);

// SVG dimensions
const svgW = 2048;
const svgH = 1365;

// Target: 90% of SVG
const targetW = svgW * 0.9;
const targetH = svgH * 0.9;

// Scale uniformly to fit within 90% of both dimensions
const scale = Math.min(targetW / contentW, targetH / contentH);

// New content size after scaling
const newW = contentW * scale;
const newH = contentH * scale;

// Center in the SVG
const offsetX = (svgW - newW) / 2;
const offsetY = (svgH - newH) / 2;

console.log(`Scale: ${scale.toFixed(4)}`);
console.log(`New size: ${newW.toFixed(1)} x ${newH.toFixed(1)}`);
console.log(`Offset: (${offsetX.toFixed(1)}, ${offsetY.toFixed(1)})`);

// Build new SVG
let lines = [`<svg xmlns="http://www.w3.org/2000/svg" width="2048" height="1365" viewBox="0 0 2048 1365">`];

for (const r of rects) {
  const nx = (r.x - minX) * scale + offsetX;
  const ny = (r.y - minY) * scale + offsetY;
  const nw = r.w * scale;
  // Add 0.5px overlap to eliminate sub-pixel gaps between rows
  const nh = r.h * scale + 0.5;
  lines.push(`<rect x="${Math.round(nx * 100) / 100}" y="${Math.round(ny * 100) / 100}" width="${Math.round(nw * 100) / 100}" height="${Math.round(nh * 100) / 100}" fill="${r.fill}"/>`);
}

lines.push(`</svg>`);

fs.writeFileSync(svgPath, lines.join("\n"), "utf-8");
console.log("SVG updated.");
