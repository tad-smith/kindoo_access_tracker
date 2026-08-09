// Shared copy for fields that take a unit's name. Three collect one —
// the bootstrap wizard (Step 3), Configuration → Wards, and Wards to
// Ignore — and they must read identically; drifting them is a recurring
// bug.

/** Labels all three fields. */
export const WARD_NAME_LABEL = 'Ward or branch name';

/**
 * Hints the two fields that CREATE a unit, where the " Ward" suffix is
 * optional but " Branch" is not — a branch is only distinguishable from a
 * ward by that suffix. Not for the Wards to Ignore field: that one matches
 * against Kindoo descriptions and wants the name verbatim, so its own
 * placeholder ("Ward name as Kindoo shows it") is the correct guidance.
 *
 * A ward in a place whose name ends in "Branch" (Olive Branch, Long
 * Branch) must be stored with the suffix — "Olive Branch Ward" — or it
 * reads as a branch. Deliberately not in the hint: operator call, kept
 * short, and an accepted risk rather than an oversight.
 *
 * The residual gap is real and unmitigated. `unitNameCollision.ts`
 * catches only the case where the stake holds BOTH units: bare
 * "Olive Branch" is rejected against a stored "Olive Branch Ward"
 * because their variant sets intersect. Where the stake's only unit in
 * that place is the ward, there is no pair and nothing rejects it — the
 * operator follows the hint, types "Olive Branch" for a ward, and
 * `unitType()` silently classifies it as a branch. `resolveScopeName`
 * then writes a Description the church automation never produces, and
 * the provisioner's strict `!==` re-fires `editUser` on every pass.
 */
export const WARD_NAME_HINT =
  'The “ Ward” suffix is optional — “Maple” and “Maple Ward” both work. A branch must end ' +
  'in “ Branch”, e.g. “Peterson Branch”.';
