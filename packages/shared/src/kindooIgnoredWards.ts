// `stake.kindoo_ignored_wards` — the comparison rules the Configuration
// UI and the extension's description parser must agree on.
//
// The list names wards that show up in one of the stake's Kindoo sites
// but are provisioned by a different SBA stake's managers. Two surfaces
// read it and both have to normalise identically, or an entry the UI
// accepts silently matches nothing in Sync:
//
//   - `apps/web` Configuration → Kindoo Sites, to reject a duplicate
//     entry and to reject one naming a ward this stake owns.
//   - the extension's `parseDescription`, to drop the matching segments.

import { kindooScopeNameVariants, normaliseUnitName } from './unitName.js';

/**
 * Comparison form for every ignore-list check: trimmed, lowercased.
 * Exported so the Configuration UI's duplicate check keys on exactly
 * what the matcher keys on.
 */
export const normaliseIgnoredWard = normaliseUnitName;

/**
 * Does `scopeName` — the ward-name portion of a Kindoo description
 * segment, i.e. the text before the parens — name a ward on the ignore
 * list? Case-insensitive and whitespace-trimmed, but otherwise exact:
 * `"Maple Ward"` matches `"maple ward  "` and never `"Maple Ward
 * Annex"` or a calling that merely contains the phrase.
 */
export function matchesIgnoredWard(
  scopeName: string,
  ignoredWards: readonly string[] | undefined,
): boolean {
  if (!ignoredWards || ignoredWards.length === 0) return false;
  const key = normaliseIgnoredWard(scopeName);
  if (key.length === 0) return false;
  return ignoredWards.some((w) => normaliseIgnoredWard(w) === key);
}

/**
 * Would adding `entry` to the ignore list name one of the stake's own
 * wards? The Configuration UI blocks that: the extension only ignores
 * segments that failed to resolve against this stake's wards, so such
 * an entry would sit in the list doing nothing while reading as though
 * it were suppressing something.
 *
 * Matches every form Kindoo could render the unit under, so `"Maple"`
 * and `"Maple Ward"` collide with each other whichever way the ward is
 * stored. A branch has one form: `"Limon Branch"` collides, and
 * `"Limon Branch Ward"` — which Kindoo never renders — does not.
 */
export function collidesWithOwnWard(entry: string, wardNames: readonly string[]): boolean {
  const key = normaliseIgnoredWard(entry);
  if (key.length === 0) return false;
  return wardNames.some((name) => kindooScopeNameVariants(name).includes(key));
}
