// Registry of platform maintenance "fixes" a superadmin can run against
// any single stake from the Stake List page's per-row Apply Fixes menu
// (spec §5.4). Each fix is one entry pointing at a superadmin-gated
// Cloud Function callable invoked as `callable({ stakeId })`.
//
// EXTENSIBILITY CONTRACT: adding a future fix is a one-object change in
// this array. Nothing downstream is fix-specific —
//   - the Apply Fixes menu iterates `STAKE_FIXES` to build its options,
//   - the Explain dialog reads `label` + `description`,
//   - the mutation calls `httpsCallable(functions, fix.callable)`,
//   - the Result dialog renders the returned object GENERICALLY (key/
//     value rows + a `warnings[]` list) so no new rendering code is
//     needed per fix.
// Keep result rendering fix-agnostic: do NOT import a callable's typed
// output here or in the Result dialog — the result is `Record<string,
// unknown>`.

export interface StakeFix {
  /** Stable id; used as the option value + React key + test ids. */
  id: string;
  /** Human label shown in the menu + as the Explain/Result dialog title. */
  label: string;
  /** Plain-language explanation shown in the Explain dialog body. */
  description: string;
  /** Name of the superadmin-gated callable, invoked as `fn({ stakeId })`. */
  callable: string;
}

export const STAKE_FIXES = [
  {
    id: 'backfill-kindoo-site-id',
    label: 'Backfill Kindoo site IDs',
    description:
      'Re-derives each seat’s Kindoo site from its ward’s assigned building and stamps the resulting kindoo_site_id onto the seat and each of its duplicate grants. It is idempotent and safe to re-run: only seats whose derived value differs from what is already stored are written, so a second run over an already-corrected stake makes no changes.',
    callable: 'backfillKindooSiteId',
  },
] as const satisfies readonly StakeFix[];

export type StakeFixId = (typeof STAKE_FIXES)[number]['id'];

/** Look up a fix by id. Returns `undefined` for an unknown id. */
export function findStakeFix(id: string): StakeFix | undefined {
  return STAKE_FIXES.find((f) => f.id === id);
}
