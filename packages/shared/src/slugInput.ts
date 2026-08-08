// `sanitizeSlugInput` — the typing-time counterpart to `buildingSlug`,
// for text inputs that hold a slug directly (the Create Stake dialog's
// Stake ID field). The field must never be able to hold a value the
// server would rewrite, so every keystroke passes through here.
//
// Why this isn't just `buildingSlug`: that helper trims trailing
// hyphens, which is right for a finished value and wrong mid-word.
// Typing `cs North` one character at a time, the space produces `cs `;
// `buildingSlug` collapses that to `cs`, so the next character lands as
// `csn` and the operator ends up with `csnorth` instead of `cs-north`.
// Keeping the trailing hyphen preserves the word boundary the operator
// just typed. Leading hyphens are still trimmed — a separator typed
// before any content has no boundary to preserve.
//
// The trailing hyphen is transient, not a value we ever store. Callers
// finalize with `buildingSlug` on blur and on submit, which trims it.
//
// Properties (locked in by tests):
//   - Idempotent up to the trailing hyphen, and its output is a fixed
//     point of `buildingSlug` whenever it doesn't end in one.
//   - `buildingSlug(sanitizeSlugInput(x)) === buildingSlug(x)` for all
//     `x` — sanitizing never changes the slug the server derives, so
//     the field can be rewritten under the operator without altering
//     the outcome.

/** Sanitize raw input for a slug text field, keeping a trailing hyphen. */
export function sanitizeSlugInput(raw: string | null | undefined): string {
  if (raw == null) return '';
  return String(raw)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-') // collapse non-alnum runs to single hyphen
    .replace(/^-+/, ''); // trim leading hyphens only — trailing is a live word boundary
}
