#!/usr/bin/env node
/*
 * Regenerate the PNG / ICO icon set under apps/web/public/ from the two
 * SVG sources in infra/scripts/icon-sources/ (large.svg, small.svg).
 *
 *   - large.svg  → 32x32, 192x192, 512x512, 180x180 apple-touch, plus
 *                  the maskable 512x512 (large design centred inside an
 *                  ~80% safe-zone square so PWA installers can crop
 *                  without clipping the mark).
 *   - small.svg  → 16x16 favicon-16x16.png; the 16-layer of favicon.ico.
 *   - favicon.svg in public/ is replaced with the large.svg verbatim
 *     (the SVG favicon scales for any rendering surface).
 *
 * favicon.ico bundles the small key for the 16 layer and the large
 * design for 32 + 48 layers.
 *
 * Run from repo root: `node infra/scripts/generate-icons.mjs`.
 */

import { readFile, writeFile, copyFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import pngToIco from 'png-to-ico';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '..', '..');
const sourcesDir = resolve(__dirname, 'icon-sources');
const publicDir = resolve(repoRoot, 'apps', 'web', 'public');

const largeSvgPath = resolve(sourcesDir, 'large.svg');
const smallSvgPath = resolve(sourcesDir, 'small.svg');

async function rasterize(svgBuffer, size, outPath) {
  await sharp(svgBuffer, { density: 384 })
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ compressionLevel: 9 })
    .toFile(outPath);
  console.log(`  wrote ${outPath} (${size}x${size})`);
}

/**
 * Maskable icon: PWA installers may crop to a circle / squircle /
 * rounded square, so the focal mark must sit inside the inner 80% of
 * the canvas. We render the source at 80% size onto a same-blue 512
 * canvas so the rounded corners of the SVG frame are masked under a
 * solid bleed. Result: cropping at any radius keeps the building+key
 * visible.
 */
async function rasterizeMaskable(svgBuffer, outPath) {
  const fullSize = 512;
  const innerSize = Math.round(fullSize * 0.8); // 410
  const inner = await sharp(svgBuffer, { density: 384 })
    .resize(innerSize, innerSize, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  const offset = Math.round((fullSize - innerSize) / 2); // 51
  await sharp({
    create: {
      width: fullSize,
      height: fullSize,
      channels: 4,
      background: { r: 0x2b, g: 0x6c, b: 0xb0, alpha: 1 },
    },
  })
    .composite([{ input: inner, top: offset, left: offset }])
    .png({ compressionLevel: 9 })
    .toFile(outPath);
  console.log(`  wrote ${outPath} (maskable 512x512, 80% safe-zone)`);
}

async function main() {
  await mkdir(publicDir, { recursive: true });
  const largeSvg = await readFile(largeSvgPath);
  const smallSvg = await readFile(smallSvgPath);

  // The site-served /favicon.svg is the large design (browsers that
  // honour SVG favicons render it at any pixel size).
  console.log('SVG favicon:');
  await copyFile(largeSvgPath, resolve(publicDir, 'favicon.svg'));
  console.log(`  copied large.svg → ${resolve(publicDir, 'favicon.svg')}`);

  console.log('PNG raster set:');
  await rasterize(smallSvg, 16, resolve(publicDir, 'favicon-16x16.png'));
  await rasterize(largeSvg, 32, resolve(publicDir, 'favicon-32x32.png'));
  await rasterize(largeSvg, 180, resolve(publicDir, 'apple-touch-icon.png'));
  await rasterize(largeSvg, 192, resolve(publicDir, 'icon-192.png'));
  await rasterize(largeSvg, 512, resolve(publicDir, 'icon-512.png'));
  await rasterizeMaskable(largeSvg, resolve(publicDir, 'icon-maskable-512.png'));

  console.log('ICO bundle:');
  // png-to-ico accepts an array of PNG buffers and packs them into a
  // multi-resolution .ico. Layer 16 uses the small key; 32 + 48 use
  // the large design.
  const ico16 = await sharp(smallSvg, { density: 384 })
    .resize(16, 16, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  const ico32 = await sharp(largeSvg, { density: 384 })
    .resize(32, 32, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  const ico48 = await sharp(largeSvg, { density: 384 })
    .resize(48, 48, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  const icoBuffer = await pngToIco([ico16, ico32, ico48]);
  await writeFile(resolve(publicDir, 'favicon.ico'), icoBuffer);
  console.log(`  wrote ${resolve(publicDir, 'favicon.ico')} (16 + 32 + 48 layers)`);

  console.log('Done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
