const sharp = require("sharp");
const path = require("path");
const fs = require("fs");

const SVG_PATH = path.join(__dirname, "..", "qgn logo.svg");
const ICONS_DIR = path.join(__dirname, "..", "icons");

async function main() {
  if (!fs.existsSync(ICONS_DIR)) {
    fs.mkdirSync(ICONS_DIR, { recursive: true });
  }

  const svg = sharp(SVG_PATH);
  const meta = await svg.metadata();

  // The SVG is 2048x1365 — crop to the center square first
  const size = Math.min(meta.width, meta.height);
  const left = Math.round((meta.width - size) / 2);
  const top = Math.round((meta.height - size) / 2);

  const squared = svg.extract({ left, top, width: size, height: size });

  // Generate icon PNGs at common sizes
  const sizes = [16, 32, 48, 64, 128, 256, 512];

  for (const s of sizes) {
    await squared
      .clone()
      .resize(s, s, { kernel: sharp.kernel.lanczos3 })
      .png()
      .toFile(path.join(ICONS_DIR, `icon-${s}.png`));
    console.log(`  icon-${s}.png`);
  }

  // Tray icons: 32x32 for standard DPI, 64x64 for high-DPI (@2x)
  for (const s of [32, 64]) {
    const name = s === 32 ? "tray.png" : "tray@2x.png";
    await squared
      .clone()
      .resize(s, s, { kernel: sharp.kernel.lanczos3 })
      .png()
      .toFile(path.join(ICONS_DIR, name));
    console.log(`  ${name}`);
  }

  console.log("Done — icons written to icons/");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
