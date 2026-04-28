// `auditId` — generate the `<ISO timestamp>_<uuid suffix>` doc ID for
// `stakes/{stakeId}/auditLog/{auditId}` and `platformAuditLog/{auditId}`
// rows per `docs/firebase-schema.md` §§3.3 and 4.10.
//
// Properties (locked in by tests):
//
//   - **Deterministic given the same `(timestamp, suffix)` inputs.**
//     The `auditTrigger` Cloud Function passes deterministic
//     `(writeTime, collection, docId)` so retries write the same row,
//     idempotent at the trigger level.
//
//   - **Sortable by reverse-lex.** ISO-8601 timestamps sort the same
//     lexicographically as chronologically; the suffix stays inside the
//     same millisecond bucket so reverse-lex sort gives newest-first
//     reads with no per-millisecond stable-order surprises (the suffix
//     is a tie-breaker, not a primary sort key).
//
//   - **No collisions for distinct inputs.** As long as either the
//     timestamp differs or the suffix differs, the resulting doc ID
//     differs. The default suffix generator uses `crypto.randomUUID()`
//     when available (Node 19+, all modern browsers); a deterministic
//     suffix is always accepted from the caller for tests and for the
//     audit-trigger idempotency case.
//
// Format: `2026-04-28T14:23:45.123Z_<suffix>` — the `_` is the
// separator. The suffix is bounded in length but not semantically
// constrained; UUIDs work, but so does any short stable string.

/** Generator hook so tests can pass a deterministic suffix. */
type SuffixSource = () => string;

const defaultSuffixSource: SuffixSource = () => {
  // `crypto.randomUUID()` is available in Node 19+ and all modern
  // browsers. The shared package targets ES2022 + bundler resolution,
  // which Node 22 (the production runtime) and Vite 5 (the SPA) both
  // satisfy comfortably.
  return globalThis.crypto.randomUUID();
};

let activeSuffixSource: SuffixSource = defaultSuffixSource;

/**
 * Build an audit doc ID from a write timestamp + an optional suffix.
 *
 * @param writeTime - The moment the underlying write happened. Pass
 *   `Date.now()`-derived `Date` from the trigger; pass a fixed `Date`
 *   from tests. The function reads `.toISOString()` to derive the
 *   leading sortable component.
 * @param suffix - Optional explicit suffix. When omitted, a fresh
 *   UUID is generated via the active suffix source. The trigger passes
 *   a deterministic `<collection>_<docId>` suffix (no spaces) so
 *   retries collide on the SAME doc ID and overwrite the same row
 *   idempotently.
 */
export function auditId(writeTime: Date, suffix?: string): string {
  const ts = writeTime.toISOString();
  const tail = suffix ?? activeSuffixSource();
  return `${ts}_${tail}`;
}

/**
 * Test-only: pin the suffix generator for the duration of a test.
 * Returns a cleanup function that restores the previous source. Not
 * re-exported from the package barrel; tests import this file
 * directly.
 */
export function _setSuffixSource(source: SuffixSource): () => void {
  const prev = activeSuffixSource;
  activeSuffixSource = source;
  return () => {
    activeSuffixSource = prev;
  };
}
