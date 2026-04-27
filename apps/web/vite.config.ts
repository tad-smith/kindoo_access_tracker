// Vite config for the Kindoo SPA.
//
// Phase 1 wires the bare minimum:
//   - React 19 plugin
//   - Dev server on 5173, preview on 4173 (Playwright targets preview)
//
// TanStack Router is currently configured code-first in src/router.tsx.
// Phase 4 switches to file-based routing under src/routes/, at which point
// we re-add the @tanstack/router-plugin/vite plugin with a routesDirectory
// option. Adding it now without a routesDirectory crashes Vite at config
// load time because the plugin can't resolve its default route directory.
//
// vite-plugin-pwa, Tailwind, shadcn-ui, etc. are deferred to Phase 4+.

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
  },
  preview: {
    port: 4173,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
