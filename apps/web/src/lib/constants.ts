// Web-side constants. Mirrors `functions/src/lib/constants.ts` for any
// value that must agree across both runtimes.
//
// Per F15 ("multi-stake from day one"), every per-stake collection path
// is parameterized on `{stakeId}`. The active stake is resolved at
// runtime by `useActiveStake()` (`lib/useActiveStake.ts`); the legacy
// `STAKE_ID = 'csnorth'` constant is gone (12.4). Type alias preserved
// for callers that constrain a doc helper's `stakeId` parameter — it's
// `string` now.

/** Type alias for a stake ID. Doc helpers in `lib/docs.ts` constrain on this. */
export type StakeId = string;
