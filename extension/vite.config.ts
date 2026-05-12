// Chrome extension build. Uses @crxjs/vite-plugin to drive the MV3 manifest
// from `src/manifest.config.ts` and produce a fully-bundled `dist/` that can
// be loaded as an unpacked extension or zipped for the Chrome Web Store.

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { crx } from '@crxjs/vite-plugin';
import manifest from './src/manifest.config';

export default defineConfig({
  plugins: [react(), crx({ manifest })],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
  },
});
