#!/usr/bin/env node
// Regenerate app icons in apps/web/public/ from the two source PNGs in
// infra/scripts/icon-sources/. The sources use a non-brand blue/cream
// palette; this script recolors per-pixel by lerping between brand blue
// and brand white based on each pixel's luminance, preserving the
// antialiased edges. Then it resizes the recolored master into every
// size the manifest + index.html reference.
//
// Usage:  node infra/scripts/generate-icons.mjs

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { writeFileSync } from 'node:fs';
import sharp from 'sharp';
import pngToIco from 'png-to-ico';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const SOURCES = join(__dirname, 'icon-sources');
const OUT = join(REPO_ROOT, 'apps', 'web', 'public');

const LARGE_SRC = join(SOURCES, 'large-source.png');
const SMALL_SRC = join(SOURCES, 'small-source.png');

// Brand palette.
const BRAND_BLUE = [43, 108, 176];   // #2b6cb0
const BRAND_WHITE = [255, 255, 255]; // #ffffff
// Source palette (sampled): blue ~rgb(16,92,154), cream ~rgb(243,240,232).
const SRC_BLUE_LUM = (16 + 92 + 154) / 3;
const SRC_WHITE_LUM = (243 + 240 + 232) / 3;

async function recolorMaster(srcPath, size) {
  const upscaled = await sharp(srcPath, { density: 300 })
    .resize(size, size, { fit: 'cover', kernel: 'lanczos3' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { data, info } = upscaled;
  const out = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i += info.channels) {
    const lum = (data[i] + data[i + 1] + data[i + 2]) / 3;
    let t = (lum - SRC_BLUE_LUM) / (SRC_WHITE_LUM - SRC_BLUE_LUM);
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
    out[i] = Math.round(BRAND_BLUE[0] + t * (BRAND_WHITE[0] - BRAND_BLUE[0]));
    out[i + 1] = Math.round(BRAND_BLUE[1] + t * (BRAND_WHITE[1] - BRAND_BLUE[1]));
    out[i + 2] = Math.round(BRAND_BLUE[2] + t * (BRAND_WHITE[2] - BRAND_BLUE[2]));
    if (info.channels === 4) out[i + 3] = data[i + 3];
  }
  return sharp(out, {
    raw: { width: info.width, height: info.height, channels: info.channels },
  });
}

async function main() {
  const largeMaster = await recolorMaster(LARGE_SRC, 512);
  const smallMaster = await recolorMaster(SMALL_SRC, 512);

  // Large-design variants.
  await largeMaster.clone().png().toFile(join(OUT, 'icon-512.png'));
  await largeMaster.clone().resize(192, 192, { kernel: 'lanczos3' }).png().toFile(join(OUT, 'icon-192.png'));
  await largeMaster.clone().resize(180, 180, { kernel: 'lanczos3' }).png().toFile(join(OUT, 'apple-touch-icon.png'));
  await largeMaster.clone().resize(32, 32, { kernel: 'lanczos3' }).png().toFile(join(OUT, 'favicon-32x32.png'));

  // Small-design (just the key) for the 16x16 favicon.
  await smallMaster.clone().resize(16, 16, { kernel: 'lanczos3' }).png().toFile(join(OUT, 'favicon-16x16.png'));

  // Maskable 512: design fits inside the central 80% safe zone with
  // brand-blue extending to all four edges so a PWA installer can crop
  // to circle / squircle / rounded-square without clipping the mark.
  await largeMaster
    .clone()
    .resize(410, 410, { fit: 'cover', kernel: 'lanczos3' })
    .extend({
      top: 51,
      bottom: 51,
      left: 51,
      right: 51,
      background: { r: 43, g: 108, b: 176, alpha: 1 },
    })
    .png()
    .toFile(join(OUT, 'icon-maskable-512.png'));

  // favicon.ico: multi-layer (16 = small key, 32 + 48 = large design).
  const ico16 = await smallMaster.clone().resize(16, 16, { kernel: 'lanczos3' }).png().toBuffer();
  const ico32 = await largeMaster.clone().resize(32, 32, { kernel: 'lanczos3' }).png().toBuffer();
  const ico48 = await largeMaster.clone().resize(48, 48, { kernel: 'lanczos3' }).png().toBuffer();
  const ico = await pngToIco([ico16, ico32, ico48]);
  writeFileSync(join(OUT, 'favicon.ico'), ico);

  // favicon.svg: embed the recolored 512 PNG as base64 inside an SVG so
  // browsers preferring SVG favicons still render the same design.
  const svgPng = await largeMaster.clone().png().toBuffer();
  const svgWrapper = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <image href="data:image/png;base64,${svgPng.toString('base64')}" width="512" height="512"/>
</svg>
`;
  writeFileSync(join(OUT, 'favicon.svg'), svgWrapper);

  // eslint-disable-next-line no-console
  console.log('icons regenerated to', OUT);
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});
