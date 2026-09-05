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
// **The stamp is a transaction, the enqueue is not.** `tasks` is a
// Firestore list, so no single element can be updated by field path and
// the stamp necessarily rewrites the whole array. A manager toggling
// `enabled` between the read at the top of a stake's pass and the write
// at the bottom was therefore silently reverted. The commit re-reads the
// doc inside `runTransaction` and re-applies only the two timestamp
// fields this pass computed, onto the array as it stands now — so a
// concurrent `enabled`, `schedule` or row removal survives. The enqueue
// stays outside, before it, unconditional: making delivery depend on a
// transaction that can abort would trade the at-least-once guarantee
// above for a silently lost fire.
//
// **What no test here proves.** Cloud Scheduler actually firing this
// function, real Cloud Tasks id deduplication, and the OIDC auth on the
// queue's callback into `runScheduledTask` have no local equivalent: the
// unit tests use a fake enqueuer and the integration tests stub it. All
// three are first exercised on staging.

import { onSchedule } from 'firebase-functions/v2/scheduler';
import { logger } from 'firebase-functions';
import { Timestamp, type DocumentReference, type Firestore } from 'firebase-admin/firestore';
import { getFunctions } from 'firebase-admin/functions';
import {
  advanceTriggerTime,
  isKnownSchedule,
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
 * One task's computed stamp, held until the commit. Carries the row's
 * position at read time AND its job name: the commit matches on the
 * position first and falls back to the name, so a concurrent write that
 * reordered or inserted rows still lands the stamp on the right row.
 */
type PendingStamp = {
  index: number;
  job: string;
  last_trigger_time: Timestamp;
  next_trigger_time: Timestamp;
};

/**
 * Firestore's own default is 5. Three is plenty for a document whose
 * only other writer is a manager clicking a toggle, and a commit that
 * loses every attempt costs one hour's stamp — the row stays due and
 * the next run re-fires it, which is the at-least-once behaviour the
 * whole design already assumes.
 */
const COMMIT_MAX_ATTEMPTS = 3;

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

      const seededRows = seedMissingTasks(tasks, registry, timezone, now);
      summary.seeded += seededRows.length;

      const stamps: PendingStamp[] = [];
      for (const [index, task] of tasks.entries()) {
        if (typeof task !== 'object' || task === null || typeof task.job !== 'string') {
          // The row itself, before either guard below can read a field
          // off it. `tasks` is rules-checked as a list of at most 50,
          // never element by element, so a `null` or a bare string can
          // sit in there — and reaching for `.job` on one would throw
          // into the per-stake handler and strand every sibling's stamp.
          // Nothing to stamp here either way: an unparseable row is
          // skipped, so this repeats hourly until someone fixes the data,
          // which is the correct amount of noise for a real misconfiguration.
          summary.failures += 1;
          logger.error('dispatchScheduledTasks: unusable row in tasks', { stakeId });
          continue;
        }
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
        if (!isKnownSchedule(task.schedule)) {
          // Rules cannot validate inside an array element and editing a
          // row in the Firestore console is the documented way to opt a
          // stake in, so a malformed `schedule` is reachable input.
          // Skipped BEFORE the enqueue, not caught after it: advancing
          // an unrecognised shape throws, and a throw between the
          // enqueue and the stamp would re-run the handler every hour
          // for as long as the row sat there.
          if (isTaskDue(task, now)) {
            summary.failures += 1;
            logger.error('dispatchScheduledTasks: due task has an unusable schedule', {
              stakeId,
              job: task.job,
              schedule: task.schedule,
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
        // file header. Computed here, applied at the commit below;
        // nothing on the in-memory row is mutated, because the array
        // this pass read is not the array that gets written. Guarded
        // per task so an unexpected throw here costs this row only:
        // uncaught it would reach the per-stake handler, which skips
        // the write entirely and would strand every OTHER task's stamp
        // in the same stake, re-firing them all an hour later.
        try {
          const previous = readTimestamp(task.next_trigger_time);
          stamps.push({
            index,
            job: task.job,
            last_trigger_time: Timestamp.fromDate(now),
            next_trigger_time: Timestamp.fromDate(
              nextTriggerTime(task.schedule, timezone, previous, now),
            ),
          });
        } catch (err) {
          summary.failures += 1;
          logger.error('dispatchScheduledTasks: could not advance a stamped task', {
            stakeId,
            job: task.job,
            errorMessage: messageOf(err),
          });
        }
      }

      if (seededRows.length > 0 || stamps.length > 0) {
        await commitScheduleChanges(db, scheduleRef, seededRows, stamps);
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
 * on the next deploy. Mutates `tasks` in place so the selection pass
 * below sees the new rows; returns them so the commit can re-check each
 * against the document as it stands at commit time.
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
): ScheduledTask[] {
  const added: ScheduledTask[] = [];
  for (const [job, definition] of Object.entries(registry)) {
    // `t?.job` rather than `t.job`: the stored array is rules-checked as
    // a list, never element by element, so a null row can sit in it and
    // must not take the seeding pass down with it. It matches no job
    // name, which is the right answer.
    if (tasks.some((t) => t?.job === job)) continue;
    const row: ScheduledTask = {
      job,
      enabled: definition.defaultEnabled,
      schedule: definition.defaultSchedule,
      next_trigger_time: Timestamp.fromDate(
        advanceTriggerTime(definition.defaultSchedule, timezone, now),
      ),
    };
    tasks.push(row);
    added.push(row);
  }
  return added;
}

/**
 * Write this pass's seeds and stamps onto `stakeSchedules/{stakeId}`
 * without clobbering a concurrent client write.
 *
 * The document is re-read inside the transaction and only the fields
 * this pass actually decided are re-applied: two timestamps per stamped
 * row, plus any row that is still missing. Everything else — `enabled`,
 * `schedule`, a row a manager deleted, a row a manager added — is
 * carried through from the current document untouched. A manager
 * flipping `enabled` while the dispatcher is mid-pass therefore keeps
 * their choice, which matters now that flipping it is a button rather
 * than a Firestore console edit.
 *
 * Deliberately NOT `FieldValue.arrayUnion`: it matches elements by deep
 * equality, so a stamped row would be appended as a second copy rather
 * than replacing the original.
 */
async function commitScheduleChanges(
  db: Firestore,
  scheduleRef: DocumentReference,
  seededRows: ScheduledTask[],
  stamps: PendingStamp[],
): Promise<void> {
  await db.runTransaction(
    async (tx) => {
      // Reads before writes, as every Firestore transaction requires —
      // and there is exactly one of each.
      const snap = await tx.get(scheduleRef);
      const stored = snap.exists ? (snap.data() as Partial<StakeSchedule>) : null;
      const current: ScheduledTask[] = Array.isArray(stored?.tasks) ? [...stored.tasks] : [];

      for (const stamp of stamps) {
        const index = indexOfStampTarget(current, stamp);
        // -1 means the row is gone — someone rewrote `tasks` without it
        // between this pass's read and here. Its handler was already
        // enqueued, but re-adding the row to carry a stamp would
        // resurrect an entry that was deliberately removed.
        if (index === -1) continue;
        current[index] = {
          ...current[index],
          last_trigger_time: stamp.last_trigger_time,
          next_trigger_time: stamp.next_trigger_time,
        } as ScheduledTask;
      }

      // Re-checked against the CURRENT array, not the one seeding ran
      // against: a concurrent writer (an overlapping dispatch, or a
      // manager) may have added the row in the meantime, and seeding
      // only ever adds what is missing.
      for (const row of seededRows) {
        if (current.some((t) => t?.job === row.job)) continue;
        current.push(row);
      }

      tx.set(scheduleRef, { tasks: current, lastActor: DISPATCHER_ACTOR }, { merge: true });
    },
    { maxAttempts: COMMIT_MAX_ATTEMPTS },
  );
}

/**
 * Where a pending stamp's row sits in the array as it stands at commit
 * time. Position first, since it is exact when nothing moved and it
 * keeps two rows naming the same job distinct; job name as the
 * fallback, for when a concurrent write shifted things.
 */
function indexOfStampTarget(current: ScheduledTask[], stamp: PendingStamp): number {
  if (current[stamp.index]?.job === stamp.job) return stamp.index;
  return current.findIndex((t) => t?.job === stamp.job);
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
