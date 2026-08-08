// Output shape for the `resolveBootstrapStake` HTTPS callable. No
// input payload — the caller is identified entirely by
// `req.auth.token.email`. See
// `functions/src/callable/resolveBootstrapStake.ts`.
export type ResolveBootstrapStakeOutput = {
  /**
   * Every not-yet-set-up stake the caller is the designated bootstrap
   * admin of, sorted ascending by doc id. A caller can be the
   * bootstrap admin of more than one stake at once (e.g. a platform
   * superadmin who is also mid-setup on a second stake); the web
   * switcher lists all of them rather than auto-selecting one. Empty
   * array when there's no match — not an error.
   */
  stakeIds: string[];
};
