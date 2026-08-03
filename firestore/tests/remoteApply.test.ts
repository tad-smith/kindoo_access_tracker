// Rules tests for the remote-apply mailbox — `remoteApply/{canonical}`
// (the desktop extension's presence + opt-in) and its
// `jobs/{jobId}` subcollection (one doc per tap on the phone).
//
// Two things are being proven here:
//
//   1. Ownership. Both docs are keyed by the manager's canonical email
//      and every predicate is anchored on `authedCanonical()`, so the
//      denial cases are "somebody else's mailbox" and "not a manager of
//      the stake in the doc".
//
//   2. The status-transition compare-and-set. The extension's MV3
//      service worker can't run `runTransaction`, so the claim lock is
//      the rules themselves: each transition pins the BEFORE status.
//      The double-claim test at the bottom is the one that matters —
//      two open Kindoo tabs poll simultaneously, both see `queued`,
//      and exactly one may win.
import { afterAll, afterEach, beforeAll, describe, it } from 'vitest';
import { assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import type { RulesTestEnvironment } from '@firebase/rules-unit-testing';
import firebase from 'firebase/compat/app';
import 'firebase/compat/firestore';
import {
  clearAll,
  lastActorOf,
  managerContext,
  personas,
  seedAsAdmin,
  setupTestEnv,
  stakeMemberContext,
  unauthedContext,
} from './lib/rules.js';

const STAKE_ID = 'csnorth';
/** A stake the mailbox owner holds no manager claim for. */
const FOREIGN_STAKE_ID = 'other-stake';

/** The mailbox owner: a Kindoo Manager under `STAKE_ID`. */
const OWNER = personas.manager;
const PRESENCE_PATH = `remoteApply/${OWNER.canonical}`;
const JOBS_PATH = `${PRESENCE_PATH}/jobs`;
const JOB_ID = 'job-1';
const JOB_PATH = `${JOBS_PATH}/${JOB_ID}`;

const SERVER_TIMESTAMP = () => firebase.firestore.FieldValue.serverTimestamp();

function presenceDoc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    remote_apply_enabled: true,
    last_seen_at: SERVER_TIMESTAMP(),
    stake_id: STAKE_ID,
    kindoo_eid: 4242,
    kindoo_site_name: 'Maple Site',
    ext_version: '2.5.0',
    lastActor: lastActorOf(OWNER),
    ...overrides,
  };
}

/** Admin-seeded form — `serverTimestamp()` isn't needed off the client path. */
function seededPresence(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return presenceDoc({ last_seen_at: new Date(), ...overrides });
}

/** Exactly what the phone writes on tap. */
function queuedJob(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    request_id: 'req-1',
    stake_id: STAKE_ID,
    status: 'queued',
    created_at: SERVER_TIMESTAMP(),
    created_by_device: 'device-abc',
    lastActor: lastActorOf(OWNER),
    ...overrides,
  };
}

/** The extension's claim payload. */
function claimPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: 'running',
    claimed_at: SERVER_TIMESTAMP(),
    claimed_by: { ext_version: '2.5.0', kindoo_eid: 4242 },
    lastActor: lastActorOf(OWNER),
    ...overrides,
  };
}

/** The extension's report-back payload. */
function finishPayload(
  status: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    status,
    finished_at: SERVER_TIMESTAMP(),
    outcome: { code: 'applied', message: 'Access granted in Kindoo.' },
    lastActor: lastActorOf(OWNER),
    ...overrides,
  };
}

async function seedJob(
  env: RulesTestEnvironment,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  await seedAsAdmin(env, async (ctx) => {
    await ctx
      .firestore()
      .doc(JOB_PATH)
      .set({
        request_id: 'req-1',
        stake_id: STAKE_ID,
        status: 'queued',
        created_at: new Date(),
        created_by_device: 'device-abc',
        lastActor: lastActorOf(OWNER),
        ...overrides,
      });
  });
}

describe('firestore.rules — remoteApply', () => {
  let env: RulesTestEnvironment;

  beforeAll(async () => {
    env = await setupTestEnv('remote-apply');
  });

  afterEach(async () => {
    await clearAll(env);
  });

  afterAll(async () => {
    await env.cleanup();
  });

  describe('presence doc', () => {
    it('owner reads their own presence doc', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx.firestore().doc(PRESENCE_PATH).set(seededPresence());
      });
      await assertSucceeds(managerContext(env, STAKE_ID).firestore().doc(PRESENCE_PATH).get());
    });

    it('anonymous read denied', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx.firestore().doc(PRESENCE_PATH).set(seededPresence());
      });
      await assertFails(unauthedContext(env).firestore().doc(PRESENCE_PATH).get());
    });

    it("another authed user is denied a read of the owner's presence doc", async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx.firestore().doc(PRESENCE_PATH).set(seededPresence());
      });
      await assertFails(stakeMemberContext(env, STAKE_ID).firestore().doc(PRESENCE_PATH).get());
    });

    it('manager creates their own presence doc', async () => {
      const db = managerContext(env, STAKE_ID).firestore();
      await assertSucceeds(db.doc(PRESENCE_PATH).set(presenceDoc()));
    });

    it('manager heartbeats (update) their own presence doc', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx.firestore().doc(PRESENCE_PATH).set(seededPresence());
      });
      const db = managerContext(env, STAKE_ID).firestore();
      await assertSucceeds(
        db.doc(PRESENCE_PATH).update({
          last_seen_at: SERVER_TIMESTAMP(),
          lastActor: lastActorOf(OWNER),
        }),
      );
    });

    it('presence doc accepts a null site (extension online, site unresolved)', async () => {
      const db = managerContext(env, STAKE_ID).firestore();
      await assertSucceeds(
        db.doc(PRESENCE_PATH).set(presenceDoc({ kindoo_eid: null, kindoo_site_name: null })),
      );
    });

    it('presence doc accepts an absent remote_apply_enabled (reads as opted out)', async () => {
      const db = managerContext(env, STAKE_ID).firestore();
      const { remote_apply_enabled: _omit, ...withoutFlag } = presenceDoc();
      await assertSucceeds(db.doc(PRESENCE_PATH).set(withoutFlag));
    });

    it('turning the toggle off (opting out) is an ordinary update', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx.firestore().doc(PRESENCE_PATH).set(seededPresence());
      });
      const db = managerContext(env, STAKE_ID).firestore();
      await assertSucceeds(
        db.doc(PRESENCE_PATH).update({
          remote_apply_enabled: false,
          lastActor: lastActorOf(OWNER),
        }),
      );
    });

    it("manager is denied a write to another member's presence doc", async () => {
      const db = managerContext(env, STAKE_ID).firestore();
      await assertFails(db.doc(`remoteApply/${personas.stakeMember.canonical}`).set(presenceDoc()));
    });

    it('non-manager is denied a write to their own presence doc', async () => {
      // Ownership alone must not be enough — otherwise any signed-in
      // user gets free storage under their own canonical email.
      const db = stakeMemberContext(env, STAKE_ID).firestore();
      await assertFails(
        db.doc(`remoteApply/${personas.stakeMember.canonical}`).set(
          presenceDoc({
            stake_id: STAKE_ID,
            lastActor: lastActorOf(personas.stakeMember),
          }),
        ),
      );
    });

    it('presence doc naming a stake the writer does not manage is denied', async () => {
      const db = managerContext(env, STAKE_ID).firestore();
      await assertFails(db.doc(PRESENCE_PATH).set(presenceDoc({ stake_id: FOREIGN_STAKE_ID })));
    });

    it('presence doc with a mismatched lastActor is denied', async () => {
      const db = managerContext(env, STAKE_ID).firestore();
      await assertFails(
        db.doc(PRESENCE_PATH).set(
          presenceDoc({
            lastActor: { email: 'Mallory@gmail.com', canonical: 'mallory@gmail.com' },
          }),
        ),
      );
    });

    it('presence doc carrying an unknown field is denied', async () => {
      const db = managerContext(env, STAKE_ID).firestore();
      await assertFails(db.doc(PRESENCE_PATH).set(presenceDoc({ smuggled: 'payload' })));
    });

    it('presence doc missing a required field is denied', async () => {
      const db = managerContext(env, STAKE_ID).firestore();
      const { ext_version: _omit, ...withoutVersion } = presenceDoc();
      await assertFails(db.doc(PRESENCE_PATH).set(withoutVersion));
    });

    it('presence doc with a mistyped field is denied', async () => {
      const db = managerContext(env, STAKE_ID).firestore();
      await assertFails(db.doc(PRESENCE_PATH).set(presenceDoc({ remote_apply_enabled: 'yes' })));
      await assertFails(db.doc(PRESENCE_PATH).set(presenceDoc({ ext_version: 3 })));
      await assertFails(db.doc(PRESENCE_PATH).set(presenceDoc({ kindoo_eid: 'site-4242' })));
    });

    it('presence doc delete is denied (opting out clears the flag instead)', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx.firestore().doc(PRESENCE_PATH).set(seededPresence());
      });
      await assertFails(managerContext(env, STAKE_ID).firestore().doc(PRESENCE_PATH).delete());
    });
  });

  describe('jobs — read', () => {
    it('owner reads and lists their own jobs', async () => {
      await seedJob(env);
      const db = managerContext(env, STAKE_ID).firestore();
      await assertSucceeds(db.doc(JOB_PATH).get());
      // The phone's live-status query: `status in ['queued','running']`,
      // no orderBy. A single-field index on `status` covers it — no
      // composite index is declared for this collection.
      await assertSucceeds(
        db.collection(JOBS_PATH).where('status', 'in', ['queued', 'running']).get(),
      );
      // The extension's poller: equality + limit(1), same single-field index.
      await assertSucceeds(db.collection(JOBS_PATH).where('status', '==', 'queued').limit(1).get());
    });

    it('anonymous read denied', async () => {
      await seedJob(env);
      await assertFails(unauthedContext(env).firestore().doc(JOB_PATH).get());
    });

    it("another authed user is denied reads and lists of the owner's jobs", async () => {
      await seedJob(env);
      const db = stakeMemberContext(env, STAKE_ID).firestore();
      await assertFails(db.doc(JOB_PATH).get());
      await assertFails(db.collection(JOBS_PATH).where('status', '==', 'queued').get());
    });
  });

  describe('jobs — create', () => {
    it('manager queues a job in their own mailbox', async () => {
      const db = managerContext(env, STAKE_ID).firestore();
      await assertSucceeds(db.doc(JOB_PATH).set(queuedJob()));
    });

    it('create with a status other than queued is denied', async () => {
      const db = managerContext(env, STAKE_ID).firestore();
      await assertFails(db.doc(JOB_PATH).set(queuedJob({ status: 'running' })));
      await assertFails(db.doc(JOB_PATH).set(queuedJob({ status: 'applied' })));
    });

    it('create pre-baking a claim or an outcome is denied', async () => {
      const db = managerContext(env, STAKE_ID).firestore();
      await assertFails(db.doc(JOB_PATH).set(queuedJob({ claimed_at: SERVER_TIMESTAMP() })));
      await assertFails(
        db.doc(JOB_PATH).set(queuedJob({ outcome: { code: 'applied', message: 'nope' } })),
      );
    });

    it('create missing a required field is denied', async () => {
      const db = managerContext(env, STAKE_ID).firestore();
      const { created_by_device: _device, ...withoutDevice } = queuedJob();
      await assertFails(db.doc(JOB_PATH).set(withoutDevice));
      const { request_id: _req, ...withoutRequest } = queuedJob();
      await assertFails(db.doc(JOB_PATH).set(withoutRequest));
    });

    it('create with an empty request_id is denied', async () => {
      const db = managerContext(env, STAKE_ID).firestore();
      await assertFails(db.doc(JOB_PATH).set(queuedJob({ request_id: '' })));
    });

    it('non-manager is denied a create in their own mailbox', async () => {
      const db = stakeMemberContext(env, STAKE_ID).firestore();
      await assertFails(
        db
          .doc(`remoteApply/${personas.stakeMember.canonical}/jobs/${JOB_ID}`)
          .set(queuedJob({ lastActor: lastActorOf(personas.stakeMember) })),
      );
    });

    it("manager is denied a create in another member's mailbox", async () => {
      const db = managerContext(env, STAKE_ID).firestore();
      await assertFails(
        db.doc(`remoteApply/${personas.stakeMember.canonical}/jobs/${JOB_ID}`).set(queuedJob()),
      );
    });

    it('create naming a stake the writer does not manage is denied', async () => {
      const db = managerContext(env, STAKE_ID).firestore();
      await assertFails(db.doc(JOB_PATH).set(queuedJob({ stake_id: FOREIGN_STAKE_ID })));
    });

    it('create with a mismatched lastActor is denied', async () => {
      const db = managerContext(env, STAKE_ID).firestore();
      await assertFails(
        db.doc(JOB_PATH).set(
          queuedJob({
            lastActor: { email: 'Mallory@gmail.com', canonical: 'mallory@gmail.com' },
          }),
        ),
      );
    });
  });

  describe('jobs — legal transitions', () => {
    it('queued → running (the extension claims the job)', async () => {
      await seedJob(env, { status: 'queued' });
      const db = managerContext(env, STAKE_ID).firestore();
      await assertSucceeds(db.doc(JOB_PATH).update(claimPayload()));
    });

    it('queued → running with no claim metadata is allowed (status is the lock)', async () => {
      await seedJob(env, { status: 'queued' });
      const db = managerContext(env, STAKE_ID).firestore();
      await assertSucceeds(
        db.doc(JOB_PATH).update({ status: 'running', lastActor: lastActorOf(OWNER) }),
      );
    });

    it("queued → cancelled (the phone's no-pickup timeout)", async () => {
      await seedJob(env, { status: 'queued' });
      const db = managerContext(env, STAKE_ID).firestore();
      // Exactly what the SPA sends: status + finished_at + lastActor.
      await assertSucceeds(
        db.doc(JOB_PATH).update({
          status: 'cancelled',
          finished_at: SERVER_TIMESTAMP(),
          lastActor: lastActorOf(OWNER),
        }),
      );
    });

    it('running → applied', async () => {
      await seedJob(env, { status: 'running' });
      const db = managerContext(env, STAKE_ID).firestore();
      await assertSucceeds(db.doc(JOB_PATH).update(finishPayload('applied')));
    });

    it('running → partial (Kindoo took the write, SBA did not)', async () => {
      await seedJob(env, { status: 'running' });
      const db = managerContext(env, STAKE_ID).firestore();
      await assertSucceeds(
        db.doc(JOB_PATH).update(
          finishPayload('partial', {
            outcome: {
              code: 'sba_incomplete',
              message: 'Applied in Kindoo — finish on the desktop.',
              kindoo_uid: 'kindoo-77',
              provisioning_note: 'Rule 12 applied.',
            },
          }),
        ),
      );
    });

    it('running → failed', async () => {
      await seedJob(env, { status: 'running' });
      const db = managerContext(env, STAKE_ID).firestore();
      await assertSucceeds(
        db.doc(JOB_PATH).update(
          finishPayload('failed', {
            outcome: { code: 'site_mismatch', message: 'Your desktop is on a different site.' },
          }),
        ),
      );
    });
  });

  describe('jobs — illegal transitions', () => {
    it('queued → applied is denied (must be claimed first)', async () => {
      await seedJob(env, { status: 'queued' });
      const db = managerContext(env, STAKE_ID).firestore();
      await assertFails(db.doc(JOB_PATH).update(finishPayload('applied')));
    });

    it('queued → partial / failed is denied', async () => {
      await seedJob(env, { status: 'queued' });
      const db = managerContext(env, STAKE_ID).firestore();
      await assertFails(db.doc(JOB_PATH).update(finishPayload('partial')));
      await assertFails(db.doc(JOB_PATH).update(finishPayload('failed')));
    });

    it('running → queued is denied (no un-claiming)', async () => {
      await seedJob(env, { status: 'running' });
      const db = managerContext(env, STAKE_ID).firestore();
      await assertFails(
        db.doc(JOB_PATH).update({ status: 'queued', lastActor: lastActorOf(OWNER) }),
      );
    });

    it('running → cancelled is denied (the timeout only applies to unclaimed jobs)', async () => {
      await seedJob(env, { status: 'running' });
      const db = managerContext(env, STAKE_ID).firestore();
      await assertFails(db.doc(JOB_PATH).update(finishPayload('cancelled')));
    });

    it('a terminal job is frozen', async () => {
      const db = managerContext(env, STAKE_ID).firestore();
      for (const terminal of ['applied', 'partial', 'failed', 'cancelled']) {
        await seedJob(env, { status: terminal });
        await assertFails(db.doc(JOB_PATH).update(claimPayload()));
        await assertFails(db.doc(JOB_PATH).update(finishPayload('failed')));
        await clearAll(env);
      }
    });

    it('a job may not be deleted', async () => {
      await seedJob(env, { status: 'applied' });
      await assertFails(managerContext(env, STAKE_ID).firestore().doc(JOB_PATH).delete());
    });

    it("another authed user cannot drive someone else's job", async () => {
      await seedJob(env, { status: 'queued' });
      const db = stakeMemberContext(env, STAKE_ID).firestore();
      await assertFails(
        db.doc(JOB_PATH).update(
          claimPayload({
            lastActor: lastActorOf(personas.stakeMember),
          }),
        ),
      );
    });

    it('a transition with a mismatched lastActor is denied', async () => {
      await seedJob(env, { status: 'queued' });
      const db = managerContext(env, STAKE_ID).firestore();
      await assertFails(
        db.doc(JOB_PATH).update(
          claimPayload({
            lastActor: { email: 'Mallory@gmail.com', canonical: 'mallory@gmail.com' },
          }),
        ),
      );
    });
  });

  describe('jobs — immutable fields', () => {
    it('a claim that also rewrites request_id is denied', async () => {
      await seedJob(env, { status: 'queued' });
      const db = managerContext(env, STAKE_ID).firestore();
      await assertFails(db.doc(JOB_PATH).update(claimPayload({ request_id: 'req-2' })));
    });

    it('a report that also rewrites stake_id is denied', async () => {
      await seedJob(env, { status: 'running' });
      const db = managerContext(env, STAKE_ID).firestore();
      await assertFails(
        db.doc(JOB_PATH).update(finishPayload('applied', { stake_id: FOREIGN_STAKE_ID })),
      );
    });

    it('a transition that also rewrites created_at / created_by_device is denied', async () => {
      const db = managerContext(env, STAKE_ID).firestore();
      await seedJob(env, { status: 'queued' });
      await assertFails(db.doc(JOB_PATH).update(claimPayload({ created_at: new Date(0) })));
      await assertFails(db.doc(JOB_PATH).update(claimPayload({ created_by_device: 'other' })));
    });

    it('a transition smuggling an unknown key is denied', async () => {
      await seedJob(env, { status: 'queued' });
      const db = managerContext(env, STAKE_ID).firestore();
      await assertFails(db.doc(JOB_PATH).update(claimPayload({ smuggled: 'payload' })));
    });

    it('a claim carrying finish fields is denied (wrong transition allowlist)', async () => {
      await seedJob(env, { status: 'queued' });
      const db = managerContext(env, STAKE_ID).firestore();
      await assertFails(db.doc(JOB_PATH).update(claimPayload({ finished_at: SERVER_TIMESTAMP() })));
    });

    it('an outcome with an unknown key or a mistyped code is denied', async () => {
      const db = managerContext(env, STAKE_ID).firestore();
      await seedJob(env, { status: 'running' });
      await assertFails(
        db
          .doc(JOB_PATH)
          .update(finishPayload('applied', { outcome: { code: 'applied', message: 1 } })),
      );
      await assertFails(
        db.doc(JOB_PATH).update(
          finishPayload('applied', {
            outcome: { code: 'applied', message: 'ok', smuggled: 'payload' },
          }),
        ),
      );
    });
  });

  // The reason the transitions are written as a compare-and-set at all.
  // Two Kindoo tabs on the same desktop poll independently; both can see
  // the same `queued` job in the same tick. Whichever `updateDoc` lands
  // first flips the status, and the loser's write — byte-identical, same
  // user, same doc — must be rejected so that tab skips the job instead
  // of running the provision a second time.
  describe('jobs — the double-claim race', () => {
    it('denies the second of two racing claims', async () => {
      await seedJob(env, { status: 'queued' });
      const tabA = managerContext(env, STAKE_ID).firestore();
      const tabB = managerContext(env, STAKE_ID).firestore();
      await assertSucceeds(tabA.doc(JOB_PATH).update(claimPayload()));
      await assertFails(tabB.doc(JOB_PATH).update(claimPayload()));
    });

    it('the winner can still report back after the loser is rejected', async () => {
      await seedJob(env, { status: 'queued' });
      const tabA = managerContext(env, STAKE_ID).firestore();
      const tabB = managerContext(env, STAKE_ID).firestore();
      await assertSucceeds(tabA.doc(JOB_PATH).update(claimPayload()));
      await assertFails(tabB.doc(JOB_PATH).update(claimPayload()));
      await assertSucceeds(tabA.doc(JOB_PATH).update(finishPayload('applied')));
    });

    it('a claim cannot race a cancel — the phone wins and the tab skips', async () => {
      await seedJob(env, { status: 'queued' });
      const phone = managerContext(env, STAKE_ID).firestore();
      const tab = managerContext(env, STAKE_ID).firestore();
      await assertSucceeds(
        phone.doc(JOB_PATH).update({
          status: 'cancelled',
          finished_at: SERVER_TIMESTAMP(),
          lastActor: lastActorOf(OWNER),
        }),
      );
      await assertFails(tab.doc(JOB_PATH).update(claimPayload()));
    });
  });
});
