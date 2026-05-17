// T-42 one-shot migration callable. Backfills `kindoo_site_id` onto
// every seat doc and every `duplicate_grants[]` entry by resolving each
// entry's `scope` to its ward's `kindoo_site_id` (stake-scope → home).
//
// Decisions locked in (spec §15 "One-shot migration"):
//
//   - Skip-if-equal. Reads the existing value on each seat / entry;
//     writes only when the derived value differs. First run produces
//     ~500-750 audit rows; re-runs over an already-migrated stake
//     produce 0 writes.
//   - Missing-ward fallback. When a `duplicate_grants[]` entry's `scope`
//     points at a ward that no longer exists, the entry is SKIPPED with
//     a logged warning. We do NOT fall back to "home" — that could
//     silently miscategorise a foreign-site grant; the entry's
//     `kindoo_site_id` simply stays as whatever it currently is (which
//     may be undefined on pre-migration docs, fine — the runtime treats
//     absent as home for backwards compat, and the next importer cycle
//     will land the right value).
//   - Audit-row churn. The `auditTrigger` recognises
//     `lastActor.canonical === 'Migration'` and emits the row under
//     `action='migration_backfill_kindoo_site_id'` (not generic
//     `update_seat`). One audit row per seat write.
//   - Scope. Per-stake; the callable takes a `stakeId` parameter.
//
// Auth: same authority check as `runImportNow` — read the
// `kindooManagers/{canonical}` doc directly. The migration is a
// manager-only operation; it does not require platform-superadmin (the
// platform-superadmin role is reserved for cross-stake operations and
// hasn't shipped in single-stake v1).
//
// Returns a counters summary so the operator can sanity-check the run
// before / after by counting expected diffs.

import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import type { Firestore } from 'firebase-admin/firestore';
import { canonicalEmail } from '@kindoo/shared';
import type { DuplicateGrant, KindooManager, Seat, Ward } from '@kindoo/shared';
import { APP_SA, getDb } from '../lib/admin.js';
import { MIGRATION_BACKFILL_KINDOO_SITE_ID_ACTOR } from '../lib/systemActors.js';

export interface BackfillKindooSiteIdInput {
  stakeId: string;
}

export interface BackfillKindooSiteIdOutput {
  ok: true;
  /** Number of seat docs read. */
  seats_total: number;
  /** Number of seat docs with at least one field updated. */
  seats_updated: number;
  /** Number of seat docs whose primary `scope` no longer resolves to a
   *  known ward — `kindoo_site_id` left untouched on those seats. */
  seats_skipped_missing_ward: number;
  /** Number of `duplicate_grants[]` entries updated across all seats. */
  duplicates_updated: number;
  /** Number of `duplicate_grants[]` entries skipped because the entry's
   *  `scope` no longer resolves to a known ward. Skipping is deliberate
   *  (see file header). */
  duplicates_skipped_missing_ward: number;
  /** Diagnostic warnings — one entry per skipped seat / duplicate,
   *  ordered by seat canonical for stable test assertions. */
  warnings: string[];
}

/**
 * Resolve a scope's expected `kindoo_site_id`. Stake-scope → home
 * (`null`); ward-scope → that ward's `kindoo_site_id` (`null` /
 * undefined on home wards becomes `null`). Returns `undefined` when
 * the scope is a ward code that doesn't resolve — caller decides
 * whether to skip the entry (duplicates) or coerce to home (primary
 * scope, where this can only happen on legacy data and a "skip
 * everything" outcome would be worse than a controlled fallback).
 */
function resolveExpectedSite(
  scope: string,
  wardsByCode: Map<string, Ward>,
): string | null | undefined {
  if (scope === 'stake') return null;
  const ward = wardsByCode.get(scope);
  if (!ward) return undefined;
  return ward.kindoo_site_id ?? null;
}

/**
 * Run the migration over one stake. Pure function modulo the
 * Firestore reads — exported so tests can drive it directly without
 * the callable wrapper.
 */
export async function backfillKindooSiteIdForStake(
  db: Firestore,
  stakeId: string,
): Promise<BackfillKindooSiteIdOutput> {
  const [wardsSnap, seatsSnap] = await Promise.all([
    db.collection(`stakes/${stakeId}/wards`).get(),
    db.collection(`stakes/${stakeId}/seats`).get(),
  ]);

  const wardsByCode = new Map<string, Ward>();
  for (const d of wardsSnap.docs) {
    const w = d.data() as Ward;
    wardsByCode.set(w.ward_code, w);
  }

  const out: BackfillKindooSiteIdOutput = {
    ok: true,
    seats_total: seatsSnap.size,
    seats_updated: 0,
    seats_skipped_missing_ward: 0,
    duplicates_updated: 0,
    duplicates_skipped_missing_ward: 0,
    warnings: [],
  };

  // Sort the seats list by doc id so warnings + audit rows land in a
  // stable order across runs (deterministic test fixtures and
  // operator-friendly logs).
  const sortedDocs = [...seatsSnap.docs].sort((a, b) => a.id.localeCompare(b.id));

  for (const seatDoc of sortedDocs) {
    const seat = seatDoc.data() as Seat;

    // ---- Primary side ----
    // The primary scope must resolve. Stake-scope → home. A ward-scope
    // primary that doesn't resolve to a known ward is a latent data
    // bug (seat references a deleted ward). Uniform missing-ward
    // policy: skip with a logged warning rather than coerce to home —
    // a misconfigured seat must not silently become home-categorised
    // (the ward may be foreign-site once the operator restores it).
    // The seat keeps its (likely absent) `kindoo_site_id` and the
    // downstream ward-fallback resolver handles classification until
    // the operator fixes the ward.
    const primaryDerived = resolveExpectedSite(seat.scope, wardsByCode);
    const primaryCurrent = (seat as Seat).kindoo_site_id ?? null;
    let primaryDiffers = false;
    let primaryTarget: string | null = primaryCurrent;
    if (primaryDerived === undefined) {
      out.seats_skipped_missing_ward += 1;
      out.warnings.push(
        `seat ${seatDoc.id}: primary scope '${seat.scope}' does not resolve to a known ward; skipping primary kindoo_site_id (ward-fallback handles classification at read time).`,
      );
    } else {
      primaryTarget = primaryDerived;
      primaryDiffers = primaryCurrent !== primaryTarget;
    }

    // ---- Duplicate side ----
    const curDupes: DuplicateGrant[] = seat.duplicate_grants ?? [];
    const nextDupes: DuplicateGrant[] = [];
    let dupesDiffer = false;
    let dupesUpdatedThisSeat = 0;
    for (const dup of curDupes) {
      const dupDerived = resolveExpectedSite(dup.scope, wardsByCode);
      if (dupDerived === undefined) {
        // Same uniform skip-with-warning policy as the primary side.
        // Preserve the entry as-is so the next importer cycle can
        // correct it (or so it stays informational until a manager
        // cleans it up). Do not error out the whole migration.
        out.duplicates_skipped_missing_ward += 1;
        out.warnings.push(
          `seat ${seatDoc.id}: duplicate_grants entry with scope '${dup.scope}' (type '${dup.type}') skipped — ward not found.`,
        );
        nextDupes.push(dup);
        continue;
      }
      const dupCurrent = dup.kindoo_site_id ?? null;
      if (dupCurrent === dupDerived) {
        nextDupes.push(dup);
        continue;
      }
      nextDupes.push({ ...dup, kindoo_site_id: dupDerived });
      dupesDiffer = true;
      dupesUpdatedThisSeat += 1;
    }

    // T-42 / T-43: keep the primitive `duplicate_scopes` mirror in
    // sync with `duplicate_grants[].scope`. Backfill if the stored
    // value differs from the derived (or is absent). Skip-if-equal
    // applies independently from the kindoo_site_id diffs so an
    // already-migrated seat's only-mirror-changed case still triggers
    // exactly one write per dirty seat.
    const derivedScopes = nextDupes.map((d) => d.scope);
    const storedScopes = seat.duplicate_scopes;
    const scopesDiffer =
      storedScopes === undefined ||
      storedScopes.length !== derivedScopes.length ||
      storedScopes.some((v, i) => v !== derivedScopes[i]);

    if (!primaryDiffers && !dupesDiffer && !scopesDiffer) continue;

    // Build the write. Only set fields that changed — minimises the
    // doc diff. `kindoo_site_id` lands only when the primary
    // resolved AND its target differs; `duplicate_grants` is replaced
    // wholesale when any duplicate changed (mirrors how the importer
    // rewrites the array).
    const update: Record<string, unknown> = {
      last_modified_at: FieldValue.serverTimestamp(),
      last_modified_by: { ...MIGRATION_BACKFILL_KINDOO_SITE_ID_ACTOR },
      lastActor: { ...MIGRATION_BACKFILL_KINDOO_SITE_ID_ACTOR },
    };
    if (primaryDiffers) update.kindoo_site_id = primaryTarget;
    if (dupesDiffer) update.duplicate_grants = nextDupes;
    if (dupesDiffer || scopesDiffer) update.duplicate_scopes = derivedScopes;

    await seatDoc.ref.set(update, { merge: true });
    out.seats_updated += 1;
    out.duplicates_updated += dupesUpdatedThisSeat;
  }

  return out;
}

export const backfillKindooSiteId = onCall(
  {
    timeoutSeconds: 540,
    memory: '512MiB',
    serviceAccount: APP_SA,
  },
  async (req): Promise<BackfillKindooSiteIdOutput> => {
    if (!req.auth) {
      throw new HttpsError('unauthenticated', 'sign in required');
    }
    const data = (req.data ?? {}) as Partial<BackfillKindooSiteIdInput>;
    const stakeId = data.stakeId;
    if (!stakeId || typeof stakeId !== 'string') {
      throw new HttpsError('invalid-argument', 'stakeId required');
    }

    const typedEmail = req.auth.token.email;
    if (!typedEmail) {
      throw new HttpsError('failed-precondition', 'auth token has no email');
    }
    const callerCanonical = canonicalEmail(typedEmail);
    const db = getDb();
    const mgrSnap = await db.doc(`stakes/${stakeId}/kindooManagers/${callerCanonical}`).get();
    if (!mgrSnap.exists) {
      throw new HttpsError('permission-denied', 'caller is not a manager of this stake');
    }
    const mgr = mgrSnap.data() as KindooManager;
    if (mgr.active !== true) {
      throw new HttpsError('permission-denied', 'manager record is inactive');
    }

    return backfillKindooSiteIdForStake(db, stakeId);
  },
);
