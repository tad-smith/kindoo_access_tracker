// Type declaration for the help-guide sync module so `vite.config.ts`
// and tests can import `syncHelp()` under `tsc` strict without TS7016.
export function syncHelp(): { count: number; outDir: string };
