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

/**
 * Comparison form for every ignore-list check: trimmed, lowercased.
 * Exported so the Configuration UI's duplicate check keys on exactly
 * what the matcher keys on.
 */
export function normaliseIgnoredWard(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * The forms a ward's name takes across the two systems. SBA stores
 * `ward_name` without the trailing `" Ward"` (`"Jackson Creek"`) while
 * Kindoo descriptions carry the full form (`"Jackson Creek Ward"`).
 * Mirrors the dual-key registration in the extension's
 * `parseDescription`; a name already ending in `" Ward"` yields one key.
 */
function wardNameVariants(wardName: string): string[] {
  const base = normaliseIgnoredWard(wardName);
  if (base.length === 0) return [];
  const suffixed = normaliseIgnoredWard(`${wardName} Ward`);
  return suffixed === base ? [base] : [base, suffixed];
}

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
 * Matches either form of the ward's name — `"Maple"` and `"Maple Ward"`
 * both collide with a ward stored as `"Maple"`.
 */
export function collidesWithOwnWard(entry: string, wardNames: readonly string[]): boolean {
  const key = normaliseIgnoredWard(entry);
  if (key.length === 0) return false;
  return wardNames.some((name) => wardNameVariants(name).includes(key));
}
