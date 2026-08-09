// Shared copy for fields that take a unit's name. Three collect one —
// the bootstrap wizard (Step 3), Configuration → Wards, and Wards to
// Ignore — and they must read identically; drifting them is a recurring
// bug.

/** Labels all three fields. */
export const WARD_NAME_LABEL = 'Ward or branch name';

/**
 * Hints the two fields that CREATE a unit, where the " Ward" suffix is
 * optional but " Branch" is not — a branch is only distinguishable from a
 * ward by that suffix. That makes a ward in a place called Olive Branch or
 * Long Branch a trap, so the hint names the escape hatch: store the
 * suffix. Not for the Wards to Ignore field: that one matches against
 * Kindoo descriptions and wants the name verbatim, so its own placeholder
 * ("Ward name as Kindoo shows it") is the correct guidance.
 */
export const WARD_NAME_HINT =
  'The “ Ward” suffix is optional — “Maple” and “Maple Ward” both work. A branch must end ' +
  'in “ Branch”, e.g. “Limon Branch”. So if your ward’s own name ends in “Branch”, write it ' +
  'out in full — “Olive Branch Ward”, not “Olive Branch” — or it will be taken for a branch.';
