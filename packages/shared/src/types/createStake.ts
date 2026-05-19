// Input / output shapes for the `createStake` HTTPS callable invoked
// from the Superadmin Stake List page (`/superadmin/stakes`, spec §5.4).
// Each click of the Create Stake form dispatches one callable
// invocation; the payload carries the operator's typed inputs and the
// callable derives the doc-ID slug + writes the parent doc.
//
// `bootstrap_admin_email` is stored on the parent stake doc
// lowercased on write; dots and `+suffix` are preserved verbatim
// (NOT `canonicalEmail()`) per F19 / `firebase-schema.md` §4.1.
// The `isBootstrapAdmin` rule compares against
// `request.auth.token.email`, which Firebase Auth always emits
// lowercased — so case must match. Dots and `+suffix` survive
// because Google itself dedupes those at sign-in to the same
// identity, keeping the Gmail escape hatch usable for operators
// who actually rely on those address variants.
//
// Failure envelope: soft-fail with `{success:false, error}` for domain
// misses (empty inputs, invalid email, invalid slug, invalid timezone,
// slug collision) so the web form can render a clean inline error
// without trapping a thrown `HttpsError`. Auth + shape errors still
// throw.

export type CreateStakeInput = {
  /** Display name — trimmed server-side. Non-empty required. */
  stake_name: string;
  /** Bootstrap admin email — trimmed + lowercased server-side; dots and `+suffix` preserved (NOT `canonicalEmail()`). Non-empty required. */
  bootstrap_admin_email: string;
  /** Optional IANA tz identifier. Defaults to `'America/Denver'` when absent. */
  timezone?: string;
};

/** Soft-failure error codes for the `{success:false}` envelope. */
export type CreateStakeError =
  | 'name_required'
  | 'email_required'
  | 'invalid_email'
  | 'slug_collision'
  | 'invalid_slug'
  | 'invalid_timezone';

export type CreateStakeResult =
  | { success: true; stakeId: string }
  | { success: false; error: CreateStakeError };
