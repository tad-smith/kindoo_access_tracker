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
//   - `firebaseMessagingSwPlugin` substitutes `VITE_FIREBASE_*` literals
//     into `src/firebase-messaging-sw.template.js` and emits the result
//     at `/firebase-messaging-sw.js` (both dev-server and build). Lives
//     here, not in `public/`, because `public/` is a static-copy step
//     with no env substitution.
//   - `vite-plugin-pwa` last so its `injectManifest` build pass picks up
//     the final asset list. Workbox strategies:
//       * cache-first for fingerprinted static assets (JS/CSS/fonts/images)
//       * network-first for `index.html` (avoid stale-shell lockout)
//       * never cache Firebase traffic (Firestore/Auth/Installations)
//
// Dev server on 5173, preview on 4173 (Playwright targets preview).

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { TanStackRouterVite } from '@tanstack/router-plugin/vite';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

/**
 * Read the FCM SW template, substitute `__VITE_FIREBASE_*__` placeholders
 * with the corresponding env values, and serve / emit the result at
 * `/firebase-messaging-sw.js`. Required because:
 *
 *   - The FCM SDK calls `getToken` / `deleteToken` against the SW at
 *     the bare path. A query-param config (the previous approach) is
 *     treated as a different script by the browser and the SDK's
 *     internal SW lookup hits an unconfigured copy.
 *   - The Vite `public/` step copies files verbatim with no env
 *     substitution, so we can't keep the SW there.
 *
 * In dev the plugin's `configureServer` middleware serves the templated
 * body on every request (no caching). In build the plugin emits a
 * single chunk via `emitFile({ type: 'asset' })` so the final SW lands
 * in `dist/firebase-messaging-sw.js` alongside the rest of the bundle.
 */
function firebaseMessagingSwPlugin(env: Record<string, string>): Plugin {
  const templatePath = resolve(__dirname, 'src/firebase-messaging-sw.template.js');
  const swPath = '/firebase-messaging-sw.js';

  function render(): string {
    const template = readFileSync(templatePath, 'utf8');
    return template
      .replace('__VITE_FIREBASE_API_KEY__', env.VITE_FIREBASE_API_KEY ?? '')
      .replace('__VITE_FIREBASE_AUTH_DOMAIN__', env.VITE_FIREBASE_AUTH_DOMAIN ?? '')
      .replace('__VITE_FIREBASE_PROJECT_ID__', env.VITE_FIREBASE_PROJECT_ID ?? 'kindoo-staging')
      .replace('__VITE_FIREBASE_MESSAGING_SENDER_ID__', env.VITE_FIREBASE_MESSAGING_SENDER_ID ?? '')
      .replace('__VITE_FIREBASE_APP_ID__', env.VITE_FIREBASE_APP_ID ?? '');
  }

  return {
    name: 'kindoo:firebase-messaging-sw',
    configureServer(server) {
      server.middlewares.use(swPath, (req, res) => {
        res.setHeader('Content-Type', 'application/javascript');
        res.setHeader('Service-Worker-Allowed', '/');
        res.setHeader('Cache-Control', 'no-store');
        res.end(render());
      });
    },
    configurePreviewServer(server) {
      // `vite preview` serves `dist/` so the build-emitted file is
      // already in place; this hook is here only to set the
      // Service-Worker-Allowed header (preview's static handler skips
      // it otherwise).
      server.middlewares.use(swPath, (_req, res, next) => {
        res.setHeader('Service-Worker-Allowed', '/');
        next();
      });
    },
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'firebase-messaging-sw.js',
        source: render(),
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  // `loadEnv(mode, '', '')` reads `.env`, `.env.<mode>`, `.env.local`,
  // `.env.<mode>.local` from the workspace root with no prefix filter.
  // We only consume `VITE_FIREBASE_*` here so a leak into the SW is
  // limited to fields we already ship in the client bundle.
  const env = loadEnv(mode, process.cwd(), '');
  return {
    plugins: [
      TanStackRouterVite({
        routesDirectory: './src/routes',
        generatedRouteTree: './src/routeTree.gen.ts',
        autoCodeSplitting: true,
        routeFileIgnorePattern: '\\.test\\.',
      }),
      react(),
      tailwindcss(),
      firebaseMessagingSwPlugin(env),
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
      // Split shared vendor code into stable named chunks. Without an
      // explicit policy the bundler's anchor-module heuristic picks an
      // arbitrary entry module for the shared lump (`cn`,
      // `LoadingSpinner`, etc.), which both flakes from one PR to the
      // next and lets the lump grow unbounded as new modules co-locate
      // into it — PR #71's role-gate refactor pulled zod into the
      // shared lump and pushed it past Vite's 500 kB warning threshold
      // even though no new code was added.
      //
      // Firebase (~380 kB) and TanStack Router/Query (~130 kB) are
      // needed on every authenticated page, so isolating them into
      // dedicated chunks gives a deterministic cache shape and keeps
      // the app entry chunk well below the warning limit. Other vendor
      // deps (Radix, dnd-kit, lucide-react, zod, etc.) stay co-split
      // by Rolldown's default heuristic so per-route chunks pay only
      // for what they use.
      rollupOptions: {
        output: {
          manualChunks: (id) => {
            if (!id.includes('node_modules')) return undefined;
            if (id.includes('firebase')) return 'vendor-firebase';
            if (id.includes('@tanstack')) return 'vendor-tanstack';
            return undefined;
          },
        },
      },
    },
  };
});
