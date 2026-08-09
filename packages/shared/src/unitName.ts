// How a stake's unit name maps to the scope name Kindoo displays.
//
// SBA stores a unit's name as the operator typed it; the trailing
// `" Ward"` is optional, so `"Maple"` and `"Maple Ward"` are the same
// unit. Kindoo always renders a ward with the suffix. A BRANCH carries
// its own suffix and Kindoo renders it verbatim — appending `" Ward"`
// to `"Peterson Branch"` produces a name the church automation never
// writes, and the provisioner then rewrites the Description on every
// pass because its comparison is a strict `!==`.
//
// The name is the only discriminator: there is no `unit_type` field.
// Three surfaces depend on this agreeing — the provisioner's write
// side, the description parser's read side, and the ignore-list
// collision check — so it lives here.

export type UnitType = 'ward' | 'branch';

/**
 * Suffix tests require preceding whitespace, so the degenerate
 * single-word names `"Ward"` / `"Branch"` are ordinary unit names, not
 * bare suffixes.
 */
const WARD_SUFFIX_RE = /\sward$/i;
const BRANCH_SUFFIX_RE = /\sbranch$/i;
const WARD_SUFFIX_SPLIT_RE = /^(.*?)\s+ward$/i;

/** Comparison form for every unit-name match: trimmed, lowercased. */
export function normaliseUnitName(value: string): string {
  return value.trim().toLowerCase();
}

/** A branch is identified solely by its name ending in " Branch". */
export function unitType(unitName: string): UnitType {
  return BRANCH_SUFFIX_RE.test(unitName.trim()) ? 'branch' : 'ward';
}

/**
 * The scope name Kindoo shows for this unit. A branch is verbatim; a
 * ward gets `" Ward"` appended only when it is absent. The caller's
 * casing is preserved either way — this normalises presence of the
 * suffix, not spelling.
 */
export function kindooScopeName(unitName: string): string {
  const trimmed = unitName.trim();
  if (trimmed.length === 0) return '';
  if (unitType(trimmed) === 'branch') return trimmed;
  return WARD_SUFFIX_RE.test(trimmed) ? trimmed : `${trimmed} Ward`;
}

/**
 * Every normalised form that should resolve to this unit when read back
 * out of a Kindoo description. A ward matches both with and without the
 * suffix; a branch matches only its verbatim name, because Kindoo never
 * renders `"Peterson Branch Ward"` and a key for it would only ever
 * mis-resolve.
 */
export function kindooScopeNameVariants(unitName: string): string[] {
  const trimmed = unitName.trim();
  if (trimmed.length === 0) return [];
  const scopeName = kindooScopeName(trimmed);
  if (unitType(trimmed) === 'branch') return [normaliseUnitName(scopeName)];
  const bare = trimmed.match(WARD_SUFFIX_SPLIT_RE)?.[1] ?? trimmed;
  const variants = [normaliseUnitName(bare), normaliseUnitName(scopeName)];
  return [...new Set(variants)];
}
