const sharp = require("sharp");
const path = require("path");
const fs = require("fs");

const SOURCE_ICON = path.join(__dirname, "..", "assets", "logos", "Icon.png");
const ICONS_DIR = path.join(__dirname, "..", "icons");

async function main() {
  if (!fs.existsSync(ICONS_DIR)) {
    fs.mkdirSync(ICONS_DIR, { recursive: true });
  }

  const source = sharp(SOURCE_ICON);
  const meta = await source.metadata();

  // Crop to center square if not already square
  const size = Math.min(meta.width, meta.height);
  const left = Math.round((meta.width - size) / 2);
  const top = Math.round((meta.height - size) / 2);

  const squared = size === meta.width && size === meta.height
    ? source
    : source.extract({ left, top, width: size, height: size });

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

  // Windows .ico (PNG-encoded ICO format)
  const icoSizes = [16, 32, 48, 64, 128, 256];
  const pngBuffers = icoSizes.map((s) => ({
    size: s,
    data: fs.readFileSync(path.join(ICONS_DIR, `icon-${s}.png`)),
  }));

  const numImages = pngBuffers.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // ICO type
  header.writeUInt16LE(numImages, 4);

  const entries = [];
  let dataOffset = 6 + numImages * 16;
  for (const img of pngBuffers) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(img.size >= 256 ? 0 : img.size, 0);
    entry.writeUInt8(img.size >= 256 ? 0 : img.size, 1);
    entry.writeUInt8(0, 2);
    entry.writeUInt8(0, 3);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(img.data.length, 8);
    entry.writeUInt32LE(dataOffset, 12);
    entries.push(entry);
    dataOffset += img.data.length;
  }

  const ico = Buffer.concat([header, ...entries, ...pngBuffers.map((i) => i.data)]);
  fs.writeFileSync(path.join(ICONS_DIR, "icon.ico"), ico);
  console.log("  icon.ico");

  console.log("Done — icons written to icons/");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
