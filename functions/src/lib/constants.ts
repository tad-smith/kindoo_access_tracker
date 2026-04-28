// Server-side constants. Mirrors `apps/web/src/lib/constants.ts` for
// values that must agree across both runtimes.
//
// `STAKE_IDS` exists per F15 (multi-stake-readiness from day one). v1
// has exactly one stake (`csnorth`); the array makes the claim-sync
// triggers' "loop over every stake to seed claims" pattern correct
// even before Phase 12 adds real multi-stake support. When a second
// stake lands, this array is the only place the constant has to grow.

/**
 * Every stake the platform serves. v1 ships exactly one entry. Phase 12
 * (Phase B) replaces this with a Firestore-driven enumeration; until
 * then, the constant is the source of truth for "which stakes do we
 * scan when seeding claims for a freshly-signed-in user?"
 */
export const STAKE_IDS = ['csnorth'] as const;

export type StakeId = (typeof STAKE_IDS)[number];
