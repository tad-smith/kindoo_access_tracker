// Chrome extension build. Uses @crxjs/vite-plugin to drive the MV3 manifest
// from `src/manifest.config.ts` and produce a fully-bundled `dist/` that can
// be loaded as an unpacked extension or zipped for the Chrome Web Store.
//
// Per-mode outDir lets the operator load BOTH staging and production builds
// side-by-side in the same Chrome profile without one overwriting the other.
// Default mode is `production` (when no --mode flag is passed).

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { crx } from '@crxjs/vite-plugin';
import manifest from './src/manifest.config';

const EXTENSION_ROOT = dirname(fileURLToPath(import.meta.url));

export default defineConfig(({ mode }) => ({
  plugins: [react(), crx({ manifest })],
  build: {
    outDir: `dist/${mode}`,
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      // SPIKE — offscreen.html is created at runtime by
      // chrome.offscreen.createDocument, so it never appears in the
      // manifest and @crxjs never finds it. Declaring it as an extra
      // HTML input is what gets the page and its bundled module emitted
      // into dist/<mode>/. An OBJECT input matters: @crxjs's
      // `crx:stub-input` plugin swaps a bare `index.html` string input
      // for its own stub, and passes object inputs through untouched.
      input: { offscreen: resolve(EXTENSION_ROOT, 'offscreen.html') },
    },
  },
}));
