// Email canonicalization shared by every workspace that needs to compare
// email addresses across boundaries (typed UI input, Firebase Auth claim,
// importer-read LCR-export cell, audit-log actor field).
//
// Rules (architecture.md D4, open-questions.md I-8):
//
//   - Lowercase + trim is universal.
//   - For @gmail.com / @googlemail.com only: strip dots from the
//     local-part, drop everything from `+` onward, fold the domain
//     to gmail.com.
//   - Workspace / non-Gmail addresses keep their dots and `+suffix`
//     literally — those are significant for non-Gmail providers.
//
// We never store the canonical form. Emails are persisted as typed; the
// canonical form is computed on demand for equality checks and for the
// importer's source-row hash where stability across format wobbles
// matters.

/**
 * Build the comparison key for an email address. Display form goes in,
 * canonical form comes out. NEVER store the result; only use it for
 * equality checks (via `emailsEqual`) or stable hashing.
 *
 * @param typed - Email as the user typed it (or as Firebase Auth handed
 *   us, or as Firestore returned). `null`/`undefined`/non-string
 *   inputs are coerced to ''.
 */
export function canonicalEmail(typed: string | null | undefined): string {
  if (typed == null) return '';
  const s = String(typed).trim().toLowerCase();
  if (s === '') return '';
  const at = s.indexOf('@');
  if (at === -1) return s;
  let local = s.substring(0, at);
  let domain = s.substring(at + 1);
  if (domain === 'gmail.com' || domain === 'googlemail.com') {
    const plus = local.indexOf('+');
    if (plus !== -1) local = local.substring(0, plus);
    local = local.replace(/\./g, '');
    domain = 'gmail.com';
  }
  return local + '@' + domain;
}

/**
 * Two display-form emails are equivalent if their canonical forms match.
 * Use whenever the comparison crosses a typed-input boundary.
 */
export function emailsEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  return canonicalEmail(a) === canonicalEmail(b);
}
