// Shared copy for the ward/branch name field. Two entry points collect it
// — the bootstrap wizard (Step 3) and Configuration → Wards — and they must
// read identically; drifting them is a recurring bug.
//
// The naming contract the hint describes: a ward's " Ward" suffix is
// optional on input, but a branch is only distinguishable from a ward by
// its " Branch" suffix, so that one is required.

export const WARD_NAME_LABEL = 'Ward or branch name';

export const WARD_NAME_HINT =
  'Enter the name as Kindoo shows it. The “ Ward” suffix is optional — “Maple” and ' +
  '“Maple Ward” both work. A branch must end in “ Branch”, e.g. “Limon Branch”.';
