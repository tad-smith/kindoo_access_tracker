// Ward → Kindoo-site resolution. A ward no longer stores `kindoo_site_id`;
// its site is derived from the building it's assigned to (the building
// carries the `kindoo_site_id`, `null`/absent = home). Resolution is
// id-first (ward's `building_id` slug) with a `building_name` fallback
// for legacy/un-migrated wards — see `resolveWardSite` in `@kindoo/shared`.

import { HttpsError } from 'firebase-functions/v2/https';
import type { Building, Ward } from '@kindoo/shared';
import { resolveWardSite } from '@kindoo/shared';

/**
 * `ward_code → kindoo_site_id` (`null` = home) for every ward, resolved
 * through its assigned building. Wards whose building is unknown resolve
 * to home (`null`), matching `resolveWardSite`.
 */
export function wardSiteMap(wards: Ward[], buildings: Building[]): Map<string, string | null> {
  const map = new Map<string, string | null>();
  for (const w of wards) {
    map.set(w.ward_code, resolveWardSite(w, buildings));
  }
  return map;
}

/**
 * Write-time invariant: a seat whose primary `scope` is a KNOWN ward that
 * resolves to a FOREIGN Kindoo site must never be persisted with
 * `kindoo_site_id` absent/null. Field-absent is the home representation
 * (spec §15 / firebase-schema §4.6), so silently persisting a foreign-ward
 * seat field-absent mis-classifies it as home — the exact bug `kindoo-only`
 * had. Every server seat writer runs this guard on the body it's about to
 * persist; the class of bug is then structurally closed, not patched
 * per-path.
 *
 * Fires ONLY when ALL of:
 *   - `scope !== 'stake'` (stake-scope is always home), AND
 *   - the ward doc for `scope` is FOUND in `wards`, AND
 *   - `resolveWardSite(ward, buildings)` is a non-null (foreign) site, AND
 *   - the body's `kindoo_site_id` is absent or null.
 *
 * Deliberately does NOT fire for:
 *   - stake-scope seats (home),
 *   - home-ward seats (`resolveWardSite` → null),
 *   - unknown/missing-ward seats (no ward doc) — preserves the
 *     "warn + leave unset, read-time fallback classifies" precedent;
 *     a missing ward is not a hard failure.
 *
 * Throws `HttpsError('internal', ...)` so the failure surfaces loudly in
 * logs and to the caller rather than committing a mis-classified seat.
 */
export function assertSeatSiteStamped(opts: {
  scope: string;
  body: { kindoo_site_id?: string | null };
  wards: readonly Ward[];
  buildings: readonly Building[];
  /** For the log message — which writer/path is persisting the seat. */
  context: string;
}): void {
  const { scope, body, wards, buildings, context } = opts;
  if (scope === 'stake') return;
  const ward = wards.find((w) => w.ward_code === scope);
  if (!ward) return; // unknown ward: read-time fallback classifies it.
  const site = resolveWardSite(ward, buildings);
  if (site === null) return; // home ward.
  // Foreign ward: the field MUST carry the site. Absent or null = the
  // home representation, which would silently mis-classify the seat.
  const stamped = body.kindoo_site_id;
  if (stamped === undefined || stamped === null) {
    throw new HttpsError(
      'internal',
      `${context}: refusing to persist seat for foreign-site ward '${scope}' ` +
        `(resolves to kindoo_site_id '${site}') with kindoo_site_id absent/null — ` +
        `field-absent means home, which would mis-classify the seat.`,
    );
  }
}
