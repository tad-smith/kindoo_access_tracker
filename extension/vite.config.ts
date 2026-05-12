// Chrome extension build. Uses @crxjs/vite-plugin to drive the MV3 manifest
// from `src/manifest.config.ts` and produce a fully-bundled `dist/` that can
// be loaded as an unpacked extension or zipped for the Chrome Web Store.
//
// Per-mode outDir lets the operator load BOTH staging and production builds
// side-by-side in the same Chrome profile without one overwriting the other.
// Default mode is `production` (when no --mode flag is passed).

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { crx } from '@crxjs/vite-plugin';
import manifest from './src/manifest.config';

export default defineConfig(({ mode }) => ({
  plugins: [react(), crx({ manifest })],
  build: {
    outDir: `dist/${mode}`,
    emptyOutDir: true,
    sourcemap: true,
  },
}));
