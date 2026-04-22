import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import sharp from 'sharp';
import pngToIco from 'png-to-ico';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const svg = readFileSync(join(root, 'src/renderer/public/icon.svg'));
const outDir = join(root, 'build');
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

const sizes = [16, 32, 48, 64, 128, 256, 512];
for (const size of sizes) {
  const file = join(outDir, `icon-${size}.png`);
  await sharp(svg).resize(size, size).png().toFile(file);
  console.log(`✓ ${file}`);
}

// Default icon.png — 256 — used by BrowserWindow on all platforms
await sharp(svg).resize(256, 256).png().toFile(join(outDir, 'icon.png'));
console.log(`✓ ${join(outDir, 'icon.png')}`);

// Windows .ico — multi-size package for Explorer / taskbar / installer
const icoSourcePngs = [16, 32, 48, 64, 128, 256].map(s => join(outDir, `icon-${s}.png`));
const ico = await pngToIco(icoSourcePngs);
writeFileSync(join(outDir, 'icon.ico'), ico);
console.log(`✓ ${join(outDir, 'icon.ico')}`);
