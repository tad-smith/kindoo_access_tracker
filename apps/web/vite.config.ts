// Vite config for the Stake Building Access SPA.
//
// Plugins (order matters):
//   - `@tanstack/router-plugin/vite` (T-17): generates
//     `src/routeTree.gen.ts` from file-based routes under `src/routes/`;
//     `autoCodeSplitting: true` produces per-route JS chunks.
//   - React 19 plugin must come AFTER the router plugin so route
//     transforms see the file-based-route exports.
//   - `@tailwindcss/vite` (T-18) reads `@theme` blocks from
//     `src/styles/tailwind.css`.
//   - `vite-plugin-pwa` last so its `injectManifest` build pass picks up
//     the final asset list. Workbox strategies:
//       * cache-first for fingerprinted static assets (JS/CSS/fonts/images)
//       * network-first for `index.html` (avoid stale-shell lockout)
//       * never cache Firebase traffic (Firestore/Auth/Installations)
//
// Dev server on 5173, preview on 4173 (Playwright targets preview).

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { TanStackRouterVite } from '@tanstack/router-plugin/vite';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    TanStackRouterVite({
      routesDirectory: './src/routes',
      generatedRouteTree: './src/routeTree.gen.ts',
      autoCodeSplitting: true,
      routeFileIgnorePattern: '\\.test\\.',
    }),
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'prompt',
      injectRegister: null,
      includeAssets: [
        'favicon.ico',
        'favicon.svg',
        'favicon-16x16.png',
        'favicon-32x32.png',
        'apple-touch-icon.png',
      ],
      manifest: {
        name: 'Stake Building Access',
        short_name: 'Building Access',
        description: 'Door-access tracker for stake building keypad seats.',
        theme_color: '#2b6cb0',
        background_color: '#ffffff',
        display: 'standalone',
        orientation: 'portrait',
        scope: '/',
        start_url: '/',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
          {
            src: '/icon-maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        navigateFallback: '/index.html',
        // Exclude the firebase-messaging-sw.js path so Workbox doesn't
        // serve `index.html` when the browser fetches the FCM SW. The
        // FCM SW lives at scope `/firebase-cloud-messaging-push-scope`
        // and must always come from disk (network-fresh). Workbox
        // owns the rest of `/`.
        navigateFallbackDenylist: [/^\/__\//, /^\/firebase-messaging-sw\.js$/],
        // Network-first for the SPA shell; cache-first for fingerprinted
        // bundle chunks (handled by precache); explicitly never cache
        // Firebase backend traffic.
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname === '/' || url.pathname === '/index.html',
            handler: 'NetworkFirst',
            options: {
              cacheName: 'sba-shell',
              networkTimeoutSeconds: 3,
              expiration: { maxEntries: 4, maxAgeSeconds: 60 * 60 * 24 * 7 },
            },
          },
          {
            urlPattern: ({ request, sameOrigin }) =>
              sameOrigin && (request.destination === 'image' || request.destination === 'font'),
            handler: 'CacheFirst',
            options: {
              cacheName: 'sba-static-assets',
              expiration: { maxEntries: 64, maxAgeSeconds: 60 * 60 * 24 * 30 },
            },
          },
          {
            urlPattern: /^https:\/\/firestore\.googleapis\.com\/.*/i,
            handler: 'NetworkOnly',
          },
          {
            urlPattern: /^https:\/\/firebaseinstallations\.googleapis\.com\/.*/i,
            handler: 'NetworkOnly',
          },
          {
            urlPattern: /^https:\/\/securetoken\.googleapis\.com\/.*/i,
            handler: 'NetworkOnly',
          },
          {
            urlPattern: /^https:\/\/identitytoolkit\.googleapis\.com\/.*/i,
            handler: 'NetworkOnly',
          },
          {
            urlPattern: /^https:\/\/.*\.firebaseio\.com\/.*/i,
            handler: 'NetworkOnly',
          },
          {
            urlPattern: /^https:\/\/.*\.cloudfunctions\.net\/.*/i,
            handler: 'NetworkOnly',
          },
        ],
      },
      devOptions: {
        // Keep the SW out of `pnpm dev` to avoid HMR cache conflicts.
        // Preview build (Playwright) registers it normally.
        enabled: false,
      },
    }),
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
