// Hourly Cloud Scheduler fire — loops over stakes, runs expiry for
// each whose `expiry_hour` matches the current local hour in its tz.

import { onSchedule } from 'firebase-functions/v2/scheduler';
import { logger } from 'firebase-functions';
import type { Stake } from '@kindoo/shared';
import { APP_SA, getDb } from '../lib/admin.js';
import { shouldRunExpiry } from '../lib/schedule.js';
import { runExpiryForStake } from '../services/Expiry.js';

export const runExpiry = onSchedule(
  {
    schedule: 'every 1 hours',
    timeZone: 'Etc/UTC',
    timeoutSeconds: 540,
    memory: '256MiB',
    serviceAccount: APP_SA,
  },
  async () => {
    const db = getDb();
    const now = new Date();
    const stakesSnap = await db.collection('stakes').get();
    for (const doc of stakesSnap.docs) {
      const stake = doc.data() as Stake;
      if (!shouldRunExpiry(stake, now)) continue;
      try {
        const result = await runExpiryForStake({ stakeId: doc.id });
        logger.info(`expiry ran for ${doc.id}`, { summary: result });
      } catch (err) {
        logger.error(`expiry failed for ${doc.id}`, err);
      }
    }
  },
);
