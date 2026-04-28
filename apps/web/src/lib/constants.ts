// Web-side constants. Mirrors `functions/src/lib/constants.ts` for any
// value that must agree across both runtimes.
//
// Per F15 ("multi-stake from day one"), every per-stake collection path
// is parameterized on `{stakeId}` even though v1 ships exactly one stake
// (`csnorth`). The hardcoded `STAKE_ID` here is the SPA's single source
// of truth for "which stake's data are we showing?" — Phase 12 swaps it
// for a stake-selector UI that reads the principal's `managerStakes`
// (etc.) and derives a current stake from the URL or local storage.
//
// Until then: change here once when a second stake is provisioned, and
// every typed-doc helper in `lib/docs.ts` (plus every reactfire hook
// downstream) follows automatically.

/**
 * The single stake the v1 SPA targets. Replace with a runtime selector
 * in Phase 12 (multi-stake) — search `STAKE_ID` for callers to migrate.
 */
export const STAKE_ID = 'csnorth';

/** Type alias so the typed-doc helper can constrain its `stakeId` arg. */
export type StakeId = typeof STAKE_ID;
