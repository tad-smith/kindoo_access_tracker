// The one Cloud Tasks worker for every scheduled job.
//
// Generic on purpose. A per-job `onTaskDispatched` function would put a
// deploy-shape change and a queue behind every new scheduled feature;
// this keeps the whole system at two deployed functions and one queue
// permanently, so adding a feature is a `taskRegistry` entry and nothing
// else.
//
// The dispatcher is at-least-once (see `dispatchScheduledTasks`), and
// Cloud Tasks retries a non-2xx up to `maxAttempts`. Handlers must
// therefore be idempotent within their own window.
//
// **What no test here proves:** the queue's OIDC auth on the callback
// into this function, and real Cloud Tasks retry behaviour. Neither has
// a local equivalent; both are first exercised on staging.

import { onTaskDispatched } from 'firebase-functions/v2/tasks';
import { defineSecret } from 'firebase-functions/params';
import { logger } from 'firebase-functions';
import { APP_SA } from '../lib/admin.js';
import { SCHEDULED_JOBS, type JobRegistry } from '../lib/taskRegistry.js';

// Registered jobs can send email (e.g. `sendSyncReminderIfDue`), so this
// worker needs the same secret binding as the notify triggers even though
// it has no email logic of its own.
const RESEND_API_KEY = defineSecret('RESEND_API_KEY');

export type RunScheduledTaskOutcome = 'ran' | 'invalid-payload' | 'unknown-job';

/**
 * Resolve `job` from the registry and run it for `stakeId`.
 *
 * Two failures return rather than throw, because retrying them can only
 * fail the same way and would burn the attempt budget: a malformed
 * payload, and a job name the registry does not carry (a stale entry
 * enqueued before a job was removed). Both log at ERROR — a scheduled
 * feature silently not running is exactly the thing that needs to be
 * visible.
 *
 * A handler that throws propagates, so Cloud Tasks retries it.
 */
export async function runScheduledTaskHandler(
  payload: unknown,
  deps: { registry?: JobRegistry; now?: Date } = {},
): Promise<RunScheduledTaskOutcome> {
  const registry = deps.registry ?? SCHEDULED_JOBS;
  const now = deps.now ?? new Date();

  const data = (payload ?? {}) as { stakeId?: unknown; job?: unknown };
  const stakeId = typeof data.stakeId === 'string' ? data.stakeId : '';
  const job = typeof data.job === 'string' ? data.job : '';
  if (!stakeId || !job) {
    logger.error('runScheduledTask: malformed payload', {
      stakeId: String(data.stakeId),
      job: String(data.job),
    });
    return 'invalid-payload';
  }

  const definition = registry[job];
  if (!definition) {
    logger.error('runScheduledTask: no handler registered for job', { stakeId, job });
    return 'unknown-job';
  }

  logger.info('runScheduledTask: running', { stakeId, job });
  const result = await definition.handler(stakeId, now);
  logger.info('runScheduledTask: done', { stakeId, job, result });
  return 'ran';
}

export const runScheduledTask = onTaskDispatched<{ stakeId: string; job: string }>(
  {
    retryConfig: { maxAttempts: 3 },
    serviceAccount: APP_SA,
    secrets: [RESEND_API_KEY],
  },
  async (request) => {
    await runScheduledTaskHandler(request.data);
  },
);
