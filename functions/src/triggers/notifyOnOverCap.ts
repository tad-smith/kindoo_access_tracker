// Fires on `stakes/{stakeId}` writes when `last_over_caps_json`
// transitions from empty to non-empty. The importer persists this
// field on every run AFTER its main lock releases; this trigger fires
// per the schema-driven event and emails managers per `spec.md` §9.
//
// "Continuing-overcap" (`[A] -> [A, B]`) and "resolving-overcap"
// (`[A] -> []`) deliberately do not fire — operators should be
// notified once when a pool tips over, not on every subsequent
// importer run that confirms the same condition.

import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { defineSecret } from 'firebase-functions/params';
import { logger } from 'firebase-functions';
import type { OverCapEntry, Stake } from '@kindoo/shared';
import { APP_SA, getDb } from '../lib/admin.js';
import { activeManagerEmails } from '../lib/managers.js';
import { notifyManagersOverCap } from '../services/EmailService.js';

// `WEB_BASE_URL` is registered at module load by `lib/params.ts`,
// imported transitively via EmailService. No re-import needed here.
const RESEND_API_KEY = defineSecret('RESEND_API_KEY');

export const notifyOnOverCap = onDocumentWritten(
  {
    document: 'stakes/{stakeId}',
    serviceAccount: APP_SA,
    secrets: [RESEND_API_KEY],
  },
  async (event) => {
    if (!event.data) return;
    const before = event.data.before?.exists ? (event.data.before.data() as Stake) : null;
    const after = event.data.after?.exists ? (event.data.after.data() as Stake) : null;
    if (!after) return;

    const beforePools = before?.last_over_caps_json ?? [];
    const afterPools = after.last_over_caps_json ?? [];
    if (!isEmptyToNonEmptyTransition(beforePools, afterPools)) return;

    const { stakeId } = event.params as { stakeId: string };
    const source: 'manual' | 'weekly' = after.last_import_triggered_by ?? 'manual';
    const db = getDb();
    const managers = await activeManagerEmails(db, stakeId);
    logger.info('notifyOnOverCap: firing', {
      stakeId,
      pools: afterPools.length,
      source,
      managers: managers.length,
    });
    await notifyManagersOverCap({
      db,
      stakeId,
      stake: after,
      pools: afterPools,
      source,
      managerEmails: managers,
    });
  },
);

function isEmptyToNonEmptyTransition(before: OverCapEntry[], after: OverCapEntry[]): boolean {
  return before.length === 0 && after.length > 0;
}
