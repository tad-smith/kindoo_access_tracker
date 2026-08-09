// Can a stake hold two units under these names? No — if they share any
// name variant.
//
// `kindooScopeNameVariants` lists every normalised form a unit answers
// to when Sync reads a name back out of a Kindoo description, and the
// parser keys ONE map by all of them. Two units contributing the same
// key means the later registration wins and the earlier unit becomes
// unresolvable, so Sync attributes its members to the wrong unit.
//
// Comparing canonical names is not sufficient. A branch `"Olive Branch"`
// and a ward `"Olive Branch Ward"` have different canonical names and
// still both answer to `"olive branch"`. The invariant is intersection
// of the variant sets, not equality of the canonical name.
//
// Two surfaces create a unit — the bootstrap wizard's Step 3 and
// Configuration → Wards — and a guard expressed twice drifts, so the
// rule and its copy live here.

import { kindooScopeName, kindooScopeNameVariants, normaliseUnitName } from './unitName.js';

export interface UnitNameCollision {
  /** The colliding unit's stored name, verbatim, for the message. */
  existingName: string;
  /** The normalised form both units answer to. */
  sharedVariant: string;
}

/**
 * The first existing name whose variant set intersects `name`'s, or
 * `null` when the name is free. Takes plain names so either surface can
 * call it without reshaping its own docs; exclude the unit being edited
 * before calling.
 */
export function findUnitNameCollision(
  name: string,
  existingNames: readonly string[],
): UnitNameCollision | null {
  const variants = kindooScopeNameVariants(name);
  if (variants.length === 0) return null;
  for (const existingName of existingNames) {
    const existing = new Set(kindooScopeNameVariants(existingName));
    const sharedVariant = variants.find((v) => existing.has(v));
    if (sharedVariant !== undefined) return { existingName, sharedVariant };
  }
  return null;
}

/**
 * A readable form of the shared variant — the operator typed one of
 * these, so echoing the normalised key back at them reads like a bug.
 * Falls back to the key when neither name produced it verbatim.
 */
function sharedVariantLabel(clash: UnitNameCollision, name: string): string {
  const candidates = [
    name,
    clash.existingName,
    kindooScopeName(name),
    kindooScopeName(clash.existingName),
  ];
  return (
    candidates.find((c) => normaliseUnitName(c) === clash.sharedVariant)?.trim() ??
    clash.sharedVariant
  );
}

/**
 * User-facing rejection for `name`, or `null` when it is free. The
 * message names the reason, because the two non-obvious cases both look
 * like false positives otherwise: `"Maple"` rejected against an existing
 * `"Maple Ward"` (same unit — the suffix is optional), and
 * `"Olive Branch Ward"` rejected against an existing branch
 * `"Olive Branch"` (different units, one shared variant).
 */
export function unitNameCollisionMessage(
  name: string,
  existingNames: readonly string[],
): string | null {
  const clash = findUnitNameCollision(name, existingNames);
  if (!clash) return null;
  const wanted = name.trim();
  const existing = clash.existingName.trim();
  const closer = 'Ward and branch names must be unique.';
  if (normaliseUnitName(wanted) === normaliseUnitName(existing)) {
    return `Another ward or branch already uses the name "${existing}". ${closer}`;
  }
  if (normaliseUnitName(kindooScopeName(wanted)) === normaliseUnitName(kindooScopeName(existing))) {
    return `"${wanted}" and the existing "${existing}" are the same ward — the " Ward" suffix is optional. ${closer}`;
  }
  const shared = sharedVariantLabel(clash, wanted);
  return `"${wanted}" collides with the existing "${existing}": Kindoo Sync reads both as "${shared}" and could not tell them apart. ${closer}`;
}
