// T-101 one-shot migration callable. Restamps `ttl` on every existing
// `stakes/{stakeId}/auditLog` row against the current `AUDIT_TTL_MS`.
//
// `ttl` is computed at write time, so extending the retention constant
// reaches new rows only; this rewrites the ones already on disk.
//
// Decisions locked in:
//
//   - `ttl` derives from the row's own `timestamp`, never wall-clock
//     now. Using now would push every historical row a full retention
//     window past the date it should expire.
//   - Skip-if-equal. A re-run over an already-migrated stake reports
//     zero writes.
//   - `BulkWriter`, not sequential awaited writes. `auditLog` is the one
//     unbounded collection in the schema (the other backfills iterate
//     ≤250-doc collections), and awaiting each write in turn would risk
//     the 540s ceiling. The read is projected to `timestamp` + `ttl`
//     via `.select()` so the fat `before` / `after` maps never land in
//     memory.
//   - No audit fan-out. `auditTrigger` is registered on the entity
//     collections, not on `auditLog`, so these writes emit nothing.
//
// Auth: PLATFORM SUPERADMIN ONLY, on the `isPlatformSuperadmin` custom
// claim — same gate as `backfillKindooSiteId`.

import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions';
import { Timestamp } from 'firebase-admin/firestore';
import type { Firestore } from 'firebase-admin/firestore';
import { AUDIT_TTL_MS } from '@kindoo/shared';
import { APP_SA, getDb } from '../lib/admin.js';

export interface BackfillAuditTtlInput {
  stakeId: string;
}

export interface BackfillAuditTtlOutput {
  ok: true;
  /** Audit rows read. */
  rows_total: number;
  /** Rows whose `ttl` was rewritten. Drops to zero on a re-run. */
  rows_updated: number;
  /** Rows already carrying the target `ttl`. */
  rows_unchanged: number;
  /** Rows with no usable `timestamp` — left untouched, nothing to derive from. */
  rows_skipped_no_timestamp: number;
  /** Rows whose write failed after BulkWriter's own retries. */
  rows_failed: number;
}

/**
 * Run the backfill over one stake. Exported so tests drive it without
 * the callable wrapper.
 */
export async function backfillAuditTtlForStake(
  db: Firestore,
  stakeId: string,
): Promise<BackfillAuditTtlOutput> {
  const snap = await db.collection(`stakes/${stakeId}/auditLog`).select('timestamp', 'ttl').get();

  const out: BackfillAuditTtlOutput = {
    ok: true,
    rows_total: snap.size,
    rows_updated: 0,
    rows_unchanged: 0,
    rows_skipped_no_timestamp: 0,
    rows_failed: 0,
  };

  const writer = db.bulkWriter();

  for (const doc of snap.docs) {
    const { timestamp, ttl } = doc.data() as { timestamp?: unknown; ttl?: unknown };
    if (!(timestamp instanceof Timestamp)) {
      out.rows_skipped_no_timestamp += 1;
      continue;
    }
    const target = Timestamp.fromMillis(timestamp.toMillis() + AUDIT_TTL_MS);
    if (ttl instanceof Timestamp && ttl.isEqual(target)) {
      out.rows_unchanged += 1;
      continue;
    }
    // Both outcomes are handled here rather than the per-op promise
    // being left floating: a rejection with no handler would surface as
    // an unhandled rejection and take the whole run down over one row.
    // Both callbacks settle before `close()` resolves, so the counters
    // are final by the time they're returned.
    void writer.update(doc.ref, { ttl: target }).then(
      () => {
        out.rows_updated += 1;
      },
      (err: unknown) => {
        out.rows_failed += 1;
        logger.error('backfillAuditTtl: row write failed', {
          stakeId,
          auditDocId: doc.id,
          errorMessage: err instanceof Error ? err.message : String(err),
        });
      },
    );
  }

  await writer.close();
  return out;
}

export const backfillAuditTtl = onCall(
  {
    timeoutSeconds: 540,
    memory: '512MiB',
    serviceAccount: APP_SA,
  },
  async (req): Promise<BackfillAuditTtlOutput> => {
    if (!req.auth) {
      throw new HttpsError('unauthenticated', 'sign in required');
    }
    const data = (req.data ?? {}) as Partial<BackfillAuditTtlInput>;
    const stakeId = data.stakeId;
    if (!stakeId || typeof stakeId !== 'string') {
      throw new HttpsError('invalid-argument', 'stakeId required');
    }
    if (req.auth.token.isPlatformSuperadmin !== true) {
      throw new HttpsError('permission-denied', 'platform superadmin required');
    }

    return backfillAuditTtlForStake(getDb(), stakeId);
  },
);
