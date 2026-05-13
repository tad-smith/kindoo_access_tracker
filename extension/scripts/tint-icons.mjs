#!/usr/bin/env node
// One-shot generator: produce orange-tinted staging variants of the
// canonical icon set. Re-run only when the prod icons change.
//
// For each prod icon under public/icons/icon-{size}.png, write a
// sibling icon-{size}-staging.png with every RGB channel blended 50%
// toward the tint color. Alpha is preserved so transparent pixels
// stay transparent (the v1 prod icons are RGB / no alpha, which pngjs
// surfaces as fully opaque — same code path either way).

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

const TINT = { r: 0xf9, g: 0x73, b: 0x16 }; // Tailwind orange-500
const BLEND = 0.5;
const SIZES = [16, 48, 128];

const __dirname = dirname(fileURLToPath(import.meta.url));
const ICONS_DIR = join(__dirname, '..', 'public', 'icons');

const lerp = (a, b, t) => Math.round(a + (b - a) * t);

for (const size of SIZES) {
  const inPath = join(ICONS_DIR, `icon-${size}.png`);
  const outPath = join(ICONS_DIR, `icon-${size}-staging.png`);
  const png = PNG.sync.read(readFileSync(inPath));
  const { data, width, height } = png;
  for (let i = 0; i < data.length; i += 4) {
    data[i] = lerp(data[i], TINT.r, BLEND);
    data[i + 1] = lerp(data[i + 1], TINT.g, BLEND);
    data[i + 2] = lerp(data[i + 2], TINT.b, BLEND);
    // data[i + 3] (alpha) intentionally untouched
  }
  const out = new PNG({ width, height });
  out.data = data;
  writeFileSync(outPath, PNG.sync.write(out));
  console.log(`[tint-icons] ${inPath} -> ${outPath}`);
}
