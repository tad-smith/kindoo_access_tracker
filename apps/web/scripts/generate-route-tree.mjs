// Generate `apps/web/src/routeTree.gen.ts` standalone.
//
// Why this exists: `routeTree.gen.ts` is plugin output from
// `@tanstack/router-plugin`. The Vite dev server and full Vite builds
// regenerate it automatically (via the plugin's `configResolved` hook),
// but plain `tsc -b` and `vitest run` import the file without running
// Vite. With the generated file ignored from git (it is — see
// `.gitignore`), CI and a fresh checkout must produce it before
// typecheck and tests run. This script does that one job and exits.
//
// Implementation: import the same Vite plugin the config uses, call its
// `configResolved` hook with a minimal `{ root }` config. That hook
// internally instantiates the `Generator` from `@tanstack/router-
// generator` and writes the file. Keeping the call shape tied to the
// installed plugin means the generated output stays bit-identical to
// what `pnpm dev` and `pnpm build` produce — no second code path to
// drift.
//
// Wired in as `pretypecheck`, `pretest`, and `pretest:unit` in
// `apps/web/package.json`. `pnpm build` and `pnpm dev` invoke Vite
// directly so they regenerate via the plugin lifecycle on their own.

import { tanstackRouterGenerator } from '@tanstack/router-plugin/vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const plugin = tanstackRouterGenerator({
  routesDirectory: './src/routes',
  generatedRouteTree: './src/routeTree.gen.ts',
  autoCodeSplitting: true,
  routeFileIgnorePattern: '\\.test\\.',
});

// The unplugin Vite shape exposes `configResolved` at the top level
// (it also exposes a nested `vite.configResolved` that delegates to the
// same body — the top-level one is what Vite actually calls). Passing
// just `{ root }` is enough; the plugin's `initConfigAndGenerator` only
// reads that field.
await plugin.configResolved({ root: webRoot });
