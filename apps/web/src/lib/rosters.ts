// Cross-feature roster helpers. Shared between bishopric/ and stake/
// roster hooks; lives in lib/ per apps/web conventions (no cross-feature
// internal imports).
//
// T-43 Phase B (spec §15): broadened-inclusion rosters issue two
// Firestore subscriptions per scope — a `where('scope', '==', X)`
// primary match and a `where('duplicate_scopes', 'array-contains', X)`
// duplicate match (KS-10 Option b). `mergeSeatsByCanonical` merges
// the two snapshot streams into a single `Seat[]` deduped by
// `member_canonical` so a seat that lands in both subscriptions
// (primary match + same-scope within-site dup) renders once.

import type { Seat } from '@kindoo/shared';

export interface RosterResult {
  data: readonly Seat[] | undefined;
  isLoading: boolean;
}

/**
 * Merge two roster subscriptions (primary-scope match + duplicate-
 * scope match) into a single `Seat[]`, deduped by `member_canonical`.
 *
 * Loading semantics: while either subscription is hydrating, surface
 * `data: undefined` so the page renders its skeleton rather than a
 * partial roster. `isLoading` is the OR of both inputs so consumers
 * can decide whether to show a spinner alongside cached data.
 */
export function mergeSeatsByCanonical(
  primary: RosterResult,
  duplicate: RosterResult,
): RosterResult {
  const isLoading = primary.isLoading || duplicate.isLoading;
  if (primary.data === undefined || duplicate.data === undefined) {
    return { data: undefined, isLoading };
  }
  const byCanonical = new Map<string, Seat>();
  for (const s of primary.data) byCanonical.set(s.member_canonical, s);
  for (const s of duplicate.data) {
    // First write wins — the primary subscription's snapshot is
    // semantically identical (same doc) so dedupe is safe.
    if (!byCanonical.has(s.member_canonical)) byCanonical.set(s.member_canonical, s);
  }
  return { data: [...byCanonical.values()], isLoading };
}
