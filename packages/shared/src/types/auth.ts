// Auth-related types shared by web (`usePrincipal`) and functions
// (claim-sync triggers). The wire format matches `docs/firebase-schema.md`
// §2 verbatim — `CustomClaims` is what `setCustomUserClaims` writes and
// what arrives on the auth token; rules read it via
// `request.auth.token.stakes[stakeId].*`.
//
// `Principal` is the derived shape the SPA renders against. It collapses
// the multi-stake `stakes` map into per-role lists so route guards and
// tab visibility checks don't have to walk the map themselves; the
// per-stake `wards` array stays addressable by stakeId for the bishopric
// case (one user can be a bishopric member in different wards across
// different stakes once Phase 12 multi-stake lands).

/** Per-stake claim block. Set by `syncAccessClaims` + `syncManagersClaims`. */
export type StakeClaims = {
  /** True iff there is an active row in `stakes/{stakeId}/kindooManagers/{canonical}`. */
  manager: boolean;
  /** True iff the user has any non-empty grant in `stakes/{stakeId}/access/{canonical}` with scope='stake'. */
  stake: boolean;
  /** Ward codes for which the user has any non-empty grant in scopes != 'stake'. Stable order. */
  wards: string[];
};

/**
 * Custom claims as written to the Firebase Auth token by the sync
 * triggers in `functions/src/triggers/`. Mirrors the layout in
 * `firebase-schema.md` §2.
 *
 * `canonical` is the canonical-email form — the value
 * `request.auth.token.canonical` returns inside Firestore rules, used
 * everywhere we need a trustworthy identity comparison without rereading
 * `userIndex`.
 */
export type CustomClaims = {
  canonical: string;
  isPlatformSuperadmin?: boolean;
  stakes?: Record<string, StakeClaims>;
};

/**
 * Authenticated-user data shape the SPA renders against.
 *
 * Derived from {@link CustomClaims} + the typed email (which only the
 * Firebase user object carries — claims hold the canonical form, not the
 * typed form). Construct via `principalFromClaims(claims, user)` in
 * `packages/shared/src/principal.ts`.
 *
 * The `Stakes` arrays preserve the parsed-claims order; downstream UIs
 * may sort by stake name independently. `bishopricWards` is keyed by
 * stakeId so multi-stake bishopric membership (Phase 12) round-trips
 * without losing the per-stake distinction.
 */
export type Principal = {
  /** Typed email (display form). Comes from the Firebase Auth user object, not from claims. */
  email: string;
  /** Canonical email — trusted identity key shared with the server. */
  canonical: string;
  /** False if no auth token, no canonical claim, or no stakes/superadmin role at all. */
  isAuthenticated: boolean;
  /** Top-level superadmin flag. */
  isPlatformSuperadmin: boolean;
  /** Stake IDs where the user has `manager === true`. */
  managerStakes: string[];
  /** Stake IDs where the user has `stake === true`. */
  stakeMemberStakes: string[];
  /** Stake ID → ward codes the user has bishopric access to in that stake. Empty entries omitted. */
  bishopricWards: Record<string, string[]>;
};
