// `buildingSlug` — derive a URL-safe doc ID from a building's display
// name. Used as the doc ID for `stakes/{stakeId}/buildings/{buildingId}`
// per `docs/firebase-schema.md` §4.3 (`'Cordera Building'` →
// `'cordera-building'`).
//
// Properties (locked in by tests):
//   - Deterministic — same input always yields same output. The
//     building doc ID never drifts under a given display name.
//   - Lowercase ASCII alnum + hyphen only. Whitespace runs collapse
//     to a single hyphen; runs of any other non-alnum character do
//     the same. Leading / trailing hyphens are trimmed. Hyphen runs
//     in the middle collapse to single hyphens.
//   - Empty input yields empty string. Caller decides whether to
//     reject or default.
//
// We deliberately don't transliterate diacritics or non-Latin
// scripts (no `Mañana` → `manana`). The buildings list is operator-
// curated; if non-ASCII names show up, we'll revisit. For now the
// safest behaviour is to drop unknown characters so the slug stays
// URL-safe.

/** Slugify a building display name into a URL-safe doc ID. */
export function buildingSlug(name: string | null | undefined): string {
  if (name == null) return '';
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-') // collapse non-alnum runs to single hyphen
    .replace(/^-+|-+$/g, ''); // trim leading/trailing hyphens
}
