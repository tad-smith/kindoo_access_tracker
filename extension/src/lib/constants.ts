// Extension-side constants. Mirrors `apps/web/src/lib/constants.ts` for
// any value that must agree across both runtimes.
//
// Per F15 ("multi-stake from day one"), every callable input that
// targets per-stake data carries `{stakeId}` even though v1 ships
// exactly one stake (`csnorth`). When multi-stake lands this gets
// replaced by a per-tab selector or a chrome.storage preference.

/**
 * The single stake the v1 extension targets. Replace with a runtime
 * selector when multi-stake lands.
 */
export const STAKE_ID = 'csnorth';
