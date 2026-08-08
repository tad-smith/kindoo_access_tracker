// Output shape for the `resolveBootstrapStake` HTTPS callable. No
// input payload — the caller is identified entirely by
// `req.auth.token.email`. See
// `functions/src/callable/resolveBootstrapStake.ts`.
export type ResolveBootstrapStakeOutput = {
  /**
   * The not-yet-set-up stake the caller is the designated bootstrap
   * admin of, or `null` when there's no match (already set up, or the
   * caller isn't a bootstrap admin of anything).
   */
  stakeId: string | null;
};
