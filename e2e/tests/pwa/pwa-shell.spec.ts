// PWA shell E2E. Exercises the user-visible install + offline + update
// surfaces against the production-style preview build (where Workbox
// wires the real service worker; `pnpm dev` mode is opted out in
// vite.config.ts).
//
// The install + update flows can't be driven from the browser shell
// directly under headless Chromium — `beforeinstallprompt` only fires
// once a heuristic engagement threshold is met, and Workbox detects an
// SW update only when an actual new revision is precached. We assert
// the deterministic surfaces here (manifest exposed, all icon assets
// reachable, SW registers on the landing page); the install-button
// gating, update-prompt rendering, and offline-indicator behaviour
// are covered exhaustively by unit tests against jsdom.

import { expect, test } from '@playwright/test';

test.describe('PWA shell', () => {
  test('serves the manifest at /manifest.webmanifest', async ({ page }) => {
    const response = await page.goto('/manifest.webmanifest');
    expect(response?.status()).toBe(200);
    const manifest = await response?.json();
    expect(manifest).toMatchObject({
      name: 'Stake Building Access',
      short_name: 'Building Access',
      display: 'standalone',
      theme_color: '#2b6cb0',
    });
    const icons = manifest.icons as Array<{ sizes: string; purpose?: string }>;
    expect(icons.some((i) => i.sizes === '192x192')).toBe(true);
    expect(icons.some((i) => i.sizes === '512x512' && !i.purpose)).toBe(true);
    expect(icons.some((i) => i.purpose === 'maskable')).toBe(true);
  });

  test('exposes apple-touch-icon + favicon assets', async ({ request }) => {
    for (const path of [
      '/apple-touch-icon.png',
      '/favicon.ico',
      '/favicon.svg',
      '/favicon-16x16.png',
      '/favicon-32x32.png',
      '/icon-192.png',
      '/icon-512.png',
      '/icon-maskable-512.png',
    ]) {
      const r = await request.get(path);
      expect(r.status(), `${path} should be 200`).toBe(200);
    }
  });

  test('index.html declares the manifest + theme + apple-touch links', async ({ request }) => {
    const html = await (await request.get('/')).text();
    expect(html).toContain('rel="manifest"');
    expect(html).toContain('theme-color');
    expect(html).toContain('apple-touch-icon');
  });

  test('registers the service worker on first load', async ({ page }) => {
    await page.goto('/');
    // The PWA registration component is mounted at the root in main.tsx,
    // so the SW registers regardless of auth state. Workbox registers on
    // window-load — give it a generous budget.
    await page.waitForFunction(
      async () => {
        if (!('serviceWorker' in navigator)) return false;
        const reg = await navigator.serviceWorker.getRegistration();
        if (!reg) return false;
        return Boolean(reg.active || reg.installing || reg.waiting);
      },
      undefined,
      { timeout: 30_000 },
    );
  });
});
