// Hourly Cloud Scheduler fire — loops over stakes, runs each whose
// `import_day` + `import_hour` match the current time in the stake's
// tz. Single-job-loops-over-stakes pattern (per F15 and the Phase 8
// "Out of scope: Per-stake Scheduler jobs").

import { onSchedule } from 'firebase-functions/v2/scheduler';
import { logger } from 'firebase-functions';
import type { Stake } from '@kindoo/shared';
import { APP_SA, getDb } from '../lib/admin.js';
import { shouldRunImporter } from '../lib/schedule.js';
import { runImporterForStake } from '../services/Importer.js';

export const runImporter = onSchedule(
  {
    schedule: 'every 1 hours',
    timeZone: 'Etc/UTC',
    timeoutSeconds: 540,
    memory: '512MiB',
    serviceAccount: APP_SA.value(),
  },
  async () => {
    const db = getDb();
    const now = new Date();
    const stakesSnap = await db.collection('stakes').get();
    for (const doc of stakesSnap.docs) {
      const stake = doc.data() as Stake;
      if (!shouldRunImporter(stake, now)) continue;
      try {
        const result = await runImporterForStake({
          stakeId: doc.id,
          triggeredBy: 'weekly-trigger',
        });
        logger.info(`importer ran for ${doc.id}`, { summary: result });
      } catch (err) {
        logger.error(`importer failed for ${doc.id}`, err);
      }
    }
  },
);
