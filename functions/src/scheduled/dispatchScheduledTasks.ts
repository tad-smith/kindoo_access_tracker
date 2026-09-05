// The per-stake cron. One hourly Cloud Function walks every stake,
// finds the tasks whose slot has arrived, and enqueues one Cloud Tasks
// task per (stake, job). Adding a scheduled feature is a `taskRegistry`
// entry, not a new Cloud Scheduler job — which is the point, because
// Scheduler's free tier is three jobs per billing account and this stack
// spends two of them on staging + prod copies of any single job.
//
// **Delivery is at-least-once, deliberately.** The order per task is
// enqueue, then stamp: the reverse loses a fire silently whenever the
// process dies between the two, and a lost fire is invisible. So a
// dispatcher retry (or a crash after enqueue) can enqueue the same task
// twice, and every handler must therefore be idempotent within its own
// window. Two things narrow the gap without closing it — the
// deterministic Cloud Tasks id below dedupes a same-hour double
// enqueue, and each handler carries its own guard (`sendSyncReminderIfDue`
// uses a stake-local date stamp) — but "must be idempotent" is the
// contract, not "is probably not called twice".
//
// **What no test here proves.** Cloud Scheduler actually firing this
// function, real Cloud Tasks id deduplication, and the OIDC auth on the
// queue's callback into `runScheduledTask` have no local equivalent: the
// unit tests use a fake enqueuer and the integration tests stub it. All
// three are first exercised on staging.

import { onSchedule } from 'firebase-functions/v2/scheduler';
import { logger } from 'firebase-functions';
import { Timestamp, type Firestore } from 'firebase-admin/firestore';
import { getFunctions } from 'firebase-admin/functions';
import {
  advanceTriggerTime,
  isTaskDue,
  nextTriggerTime,
  type ScheduledTask,
  type StakeSchedule,
} from '@kindoo/shared';
import { APP_SA, getDb } from '../lib/admin.js';
import { SCHEDULED_JOBS, type JobRegistry } from '../lib/taskRegistry.js';

/** Name of the `onTaskDispatched` function every scheduled job is enqueued against. */
export const TASK_RUNNER_NAME = 'runScheduledTask';

/**
 * Logged once per completed run. **Load-bearing outside this repo:** the
 * `scheduled-dispatch-completed` log-based metric
 * (`infra/monitoring/`) matches this text and alerts on its ABSENCE,
 * because the dispatcher swallows per-stake failures and a run in which
 * everything failed still exits 0. Reword it and the metric silently
 * reads zero, which is indistinguishable from the outage it detects.
 * Pinned by a test; change both sides and the metric together.
 */
export const DISPATCH_DONE_MESSAGE = 'dispatchScheduledTasks: done';

/**
 * Synthetic actor stamped on `stakeSchedules/{stakeId}`. Follows the
 * `'RemoveTrigger'` precedent for server-driven writes. Writes to this
 * collection are NOT audited (the doc is deliberately outside
 * `stakes/{stakeId}` so the hourly stamp fans no audit row), so this is
 * bookkeeping for a human reading the doc, not an audit trail.
 */
export const DISPATCHER_ACTOR = {
  email: 'ScheduledTaskDispatcher',
  canonical: 'ScheduledTaskDispatcher',
} as const;

/** Payload `runScheduledTask` receives. */
export type ScheduledTaskPayload = { stakeId: string; job: string };

/** Enqueue one task. `id` is the Cloud Tasks dedupe key. */
export type EnqueueTask = (payload: ScheduledTaskPayload, id: string) => Promise<void>;

export type DispatchOptions = {
  registry: JobRegistry;
  enqueue: EnqueueTask;
  now: Date;
};

export type DispatchSummary = {
  stakes: number;
  /** Task entries appended by self-seeding. */
  seeded: number;
  enqueued: number;
  /** Enqueues Cloud Tasks rejected as already-existing — a dedupe hit, counted as success. */
  deduped: number;
  /** Stakes or tasks that threw. Logged, never fatal; the next hour retries. */
  failures: number;
};

/**
 * Admin SDK error code for an id that names an existing (or
 * recently-executed) task. This is the dedupe landing, not a failure:
 * some other invocation already enqueued this stake+job for this hour.
 */
const TASK_ALREADY_EXISTS = 'functions/task-already-exists';

/**
 * Deterministic Cloud Tasks id for one (stake, job, hour). Two
 * dispatcher runs in the same UTC hour produce the same id, so the
 * second enqueue is rejected instead of double-running the job.
 *
 * Sanitised to the Cloud Tasks id charset (`[A-Za-z0-9_-]`); the `--`
 * separators and the `T` in the hour bucket are all inside it, so a
 * slug-shaped stakeId passes through unchanged.
 */
export function scheduledTaskId(stakeId: string, job: string, now: Date): string {
  // `2026-09-05T14:03:00.000Z` → `20260905T14`.
  const bucket = now.toISOString().slice(0, 13).replace(/[-:]/g, '');
  return `${stakeId}--${job}--${bucket}`.replace(/[^A-Za-z0-9_-]/g, '_');
}

/**
 * The dispatcher's whole body, with the Firestore handle and the three
 * moving parts injected so it is testable without Cloud Scheduler or
 * Cloud Tasks.
 *
 * One stake's failure is logged and skipped — a stake with a malformed
 * schedule doc must not stop every other stake's tasks from firing.
 */
export async function dispatchDue(
  db: Firestore,
  { registry, enqueue, now }: DispatchOptions,
): Promise<DispatchSummary> {
  const summary: DispatchSummary = {
    stakes: 0,
    seeded: 0,
    enqueued: 0,
    deduped: 0,
    failures: 0,
  };

  const stakesSnap = await db.collection('stakes').get();
  summary.stakes = stakesSnap.size;

  for (const stakeDoc of stakesSnap.docs) {
    const stakeId = stakeDoc.id;
    try {
      const timezone = (stakeDoc.data() as { timezone?: string }).timezone;
      const scheduleRef = db.doc(`stakeSchedules/${stakeId}`);
      const scheduleSnap = await scheduleRef.get();
      const stored = scheduleSnap.exists ? (scheduleSnap.data() as Partial<StakeSchedule>) : null;
      const tasks: ScheduledTask[] = Array.isArray(stored?.tasks) ? [...stored.tasks] : [];

      const seeded = seedMissingTasks(tasks, registry, timezone, now);
      summary.seeded += seeded;

      let stamped = 0;
      for (const task of tasks) {
        if (!(task.job in registry)) {
          // An entry naming a job that no longer exists (or does not
          // exist yet). Left untouched rather than pruned: re-adding the
          // job restores the manager's own `enabled` choice.
          if (isTaskDue(task, now)) {
            logger.warn('dispatchScheduledTasks: due task names an unknown job', {
              stakeId,
              job: task.job,
            });
          }
          continue;
        }
        if (!isTaskDue(task, now)) continue;

        const id = scheduledTaskId(stakeId, task.job, now);
        try {
          await enqueue({ stakeId, job: task.job }, id);
          summary.enqueued += 1;
        } catch (err) {
          if (errorCode(err) === TASK_ALREADY_EXISTS) {
            // Already enqueued for this hour by an earlier attempt.
            // Fall through to the stamp so the schedule still advances.
            summary.deduped += 1;
            logger.info('dispatchScheduledTasks: task already enqueued for this window', {
              stakeId,
              job: task.job,
              taskId: id,
            });
          } else {
            // Leave the task unstamped so it stays due and the next
            // hourly run retries it.
            summary.failures += 1;
            logger.error('dispatchScheduledTasks: enqueue failed', {
              stakeId,
              job: task.job,
              taskId: id,
              errorMessage: messageOf(err),
            });
            continue;
          }
        }

        // Stamp AFTER the enqueue — see the at-least-once note in the
        // file header.
        const previous = readTimestamp(task.next_trigger_time);
        task.last_trigger_time = Timestamp.fromDate(now);
        task.next_trigger_time = Timestamp.fromDate(
          nextTriggerTime(task.schedule, timezone, previous, now),
        );
        stamped += 1;
      }

      if (seeded > 0 || stamped > 0) {
        await scheduleRef.set({ tasks, lastActor: DISPATCHER_ACTOR }, { merge: true });
      }
    } catch (err) {
      summary.failures += 1;
      logger.error('dispatchScheduledTasks: stake failed', {
        stakeId,
        errorMessage: messageOf(err),
      });
    }
  }

  return summary;
}

/**
 * Append an entry for every registry job the stake has none for.
 *
 * **Only ever adds.** An existing entry is never rewritten, never
 * re-enabled, and never re-scheduled — a manager's `enabled: false` is a
 * decision, and a seeder that "restores defaults" would silently undo it
 * on the next deploy. Mutates `tasks` in place; returns how many it
 * appended.
 *
 * This is why `createStake` seeds nothing: the dispatcher's first pass
 * over a new stake does it, which also covers stakes created before a
 * job existed.
 */
function seedMissingTasks(
  tasks: ScheduledTask[],
  registry: JobRegistry,
  timezone: string | undefined,
  now: Date,
): number {
  let added = 0;
  for (const [job, definition] of Object.entries(registry)) {
    if (tasks.some((t) => t.job === job)) continue;
    tasks.push({
      job,
      enabled: definition.defaultEnabled,
      schedule: definition.defaultSchedule,
      next_trigger_time: Timestamp.fromDate(
        advanceTriggerTime(definition.defaultSchedule, timezone, now),
      ),
    });
    added += 1;
  }
  return added;
}

/**
 * The stored `next_trigger_time` as a `Date`, or `undefined` when the
 * field is absent or holds something that isn't a readable timestamp. A
 * hand-edited doc must re-base rather than throw.
 */
function readTimestamp(value: ScheduledTask['next_trigger_time']): Date | undefined {
  const date = typeof value?.toDate === 'function' ? value.toDate() : undefined;
  return date instanceof Date && Number.isFinite(date.getTime()) ? date : undefined;
}

function errorCode(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Production enqueuer — the Cloud Tasks queue the Firebase CLI provisions for `runScheduledTask`. */
function enqueueViaCloudTasks(payload: ScheduledTaskPayload, id: string): Promise<void> {
  return getFunctions().taskQueue<ScheduledTaskPayload>(TASK_RUNNER_NAME).enqueue(payload, { id });
}

/**
 * Hourly on the hour, UTC.
 *
 * The cron string is deliberate: `every 1 hours` fires relative to
 * deploy time, which would put the run at an arbitrary minute and
 * detach it from the `YYYYMMDDTHH` bucket the dedupe id is built from.
 * `Etc/UTC` for the same reason — the per-stake zone is applied when
 * computing the next slot, not when waking up.
 */
export const dispatchScheduledTasks = onSchedule(
  {
    schedule: '0 * * * *',
    timeZone: 'Etc/UTC',
    memory: '256MiB',
    serviceAccount: APP_SA,
  },
  async () => {
    const summary = await dispatchDue(getDb(), {
      registry: SCHEDULED_JOBS,
      enqueue: enqueueViaCloudTasks,
      now: new Date(),
    });
    logger.info(DISPATCH_DONE_MESSAGE, summary);
  },
);
