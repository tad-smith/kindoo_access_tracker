// `ImportSummary` — return shape of `runImportNow` and the scheduled
// importer's per-stake cycle. Lives in `@kindoo/shared` so both the
// Cloud Function (`functions/src/services/Importer.ts`) and the SPA's
// manager Import page can type the callable response without the
// client reaching into `functions/`.

import type { OverCapEntry } from './stake.js';

export type ImportSummary = {
  ok: boolean;
  inserted: number;
  deleted: number;
  updated: number;
  access_added: number;
  access_removed: number;
  warnings: string[];
  skipped_tabs: string[];
  over_caps: OverCapEntry[];
  elapsed_ms: number;
  triggered_by: string;
  error?: string;
};
