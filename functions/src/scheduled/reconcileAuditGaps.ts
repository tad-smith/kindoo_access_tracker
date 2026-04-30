// Nightly reconciliation — for each stake, sample entity-collection
// counts vs auditLog row counts. If the gap exceeds 1%, log a warning
// (alert-channel wiring tracked in TASKS.md / open-questions.md Q14).
//
// At v1 scale (~250 seats, 1–2 requests/week, ~12 wards) the full
// scan is trivially cheap — no need to page or batch.

import { onSchedule } from 'firebase-functions/v2/scheduler';
import { logger } from 'firebase-functions';
import { getDb } from '../lib/admin.js';

const AUDITED_COLLECTIONS = [
  'wards',
  'buildings',
  'kindooManagers',
  'access',
  'seats',
  'requests',
  'wardCallingTemplates',
  'stakeCallingTemplates',
] as const;

export const reconcileAuditGaps = onSchedule(
  {
    schedule: 'every day 04:00',
    timeZone: 'America/Denver',
    timeoutSeconds: 540,
    memory: '256MiB',
  },
  async () => {
    const db = getDb();
    const stakesSnap = await db.collection('stakes').get();
    for (const doc of stakesSnap.docs) {
      const stakeId = doc.id;
      let totalEntities = 0;
      for (const collection of AUDITED_COLLECTIONS) {
        const c = await db.collection(`stakes/${stakeId}/${collection}`).count().get();
        totalEntities += c.data().count;
      }
      const auditCount = (await db.collection(`stakes/${stakeId}/auditLog`).count().get()).data()
        .count;
      // A healthy stake has at least one audit row per entity (entities
      // were created at some point). Stricter checks (history depth)
      // would require sampling — out of scope for the alert gate.
      const gapPct =
        totalEntities === 0 ? 0 : Math.max(0, (totalEntities - auditCount) / totalEntities);
      if (gapPct > 0.01) {
        logger.warn(`audit-log gap on ${stakeId}`, {
          stakeId,
          totalEntities,
          auditCount,
          gapPct,
        });
      } else {
        logger.info(`audit reconciliation ok for ${stakeId}`, { totalEntities, auditCount });
      }
    }
  },
);
