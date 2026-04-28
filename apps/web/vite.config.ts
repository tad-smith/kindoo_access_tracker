// Vite config for the Kindoo SPA.
//
// Phase 4 wires:
//   - `@tanstack/router-plugin/vite` (T-17): generates
//     `src/routeTree.gen.ts` from file-based routes under
//     `src/routes/`; `autoCodeSplitting: true` produces per-route JS
//     chunks so heavyweight pages don't bloat the initial bundle.
//   - React 19 plugin (must come AFTER the router plugin so route
//     transforms see the file-based-route exports).
//   - Dev server on 5173, preview on 4173 (Playwright targets preview).
//
// Phase 5 (T-18) adds Tailwind v4 via `@tailwindcss/vite`. Tailwind v4
// reads its theme config from CSS (`@theme` in `src/styles/tailwind.css`)
// rather than a JS config file; the design tokens from
// `src/styles/tokens.css` are mirrored into Tailwind's color/spacing
// scales so utility classes (`bg-kd-primary`, etc.) compose with the
// existing component CSS without duplicating values.
//
// vite-plugin-pwa is deferred to Phase 10.

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { TanStackRouterVite } from '@tanstack/router-plugin/vite';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [
    TanStackRouterVite({
      routesDirectory: './src/routes',
      generatedRouteTree: './src/routeTree.gen.ts',
      autoCodeSplitting: true,
    }),
    react(),
    tailwindcss(),
  ],
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
