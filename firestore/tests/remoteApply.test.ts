// Rules tests for the remote-apply mailbox — `remoteApply/{canonical}`
// (the profile-wide opt-in), its `desktops/{siteId}` subcollection (one
// doc per live Kindoo tab) and its `jobs/{jobId}` subcollection (one doc
// per tap on the phone).
//
// Three things are being proven here:
//
//   1. Ownership. Every doc is keyed by the manager's canonical email
//      and every predicate is anchored on `authedCanonical()`, so the
//      denial cases are "somebody else's mailbox" and "not a manager of
//      the stake in the doc".
//
//   2. Per-site presence. Two tabs on two Kindoo sites must BOTH be able
//      to publish liveness — the previous one-doc-per-manager shape had
//      them overwriting each other's EID every heartbeat. The coexistence
//      test in the `desktops` block is the one that matters.
//
//   3. The status-transition compare-and-set. The extension's MV3
//      service worker can't run `runTransaction`, so the claim lock is
//      the rules themselves: each transition pins the BEFORE status.
//      The double-claim test at the bottom is the one that matters —
//      two open Kindoo tabs poll simultaneously, both see `queued`,
//      and exactly one may win.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
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
const DESKTOPS_PATH = `${PRESENCE_PATH}/desktops`;
const JOBS_PATH = `${PRESENCE_PATH}/jobs`;
const JOB_ID = 'job-1';
const JOB_PATH = `${JOBS_PATH}/${JOB_ID}`;

/**
 * Two Kindoo sites in the same stake — the case the whole per-site
 * reshape exists for.
 *
 * `SITE_HOME` is `REMOTE_APPLY_HOME_SITE_KEY`: the stake's home site has
 * no `kindooSites` doc to take an id from, so it publishes under a
 * reserved key and its `kindoo_site_id` body field is null. A foreign
 * site's key IS its `kindooSites` slug. The rules don't constrain either
 * one, so to them both are just strings.
 */
const SITE_HOME = 'home';
const SITE_FOREIGN = 'oak-site';

const desktopPath = (siteKey: string): string => `${DESKTOPS_PATH}/${siteKey}`;

const SERVER_TIMESTAMP = () => firebase.firestore.FieldValue.serverTimestamp();

/** `RemoteApplyPresence` — the opt-in and nothing else. */
function presenceDoc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    remote_apply_enabled: true,
    ext_version: '2.5.0',
    lastActor: lastActorOf(OWNER),
    ...overrides,
  };
}

/**
 * `RemoteApplyDesktop` — one live Kindoo tab's heartbeat. Defaults to a
 * foreign site, since that is the shape with a non-null `kindoo_site_id`;
 * the home case passes `{ kindoo_site_id: null }`.
 */
function desktopDoc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    stake_id: STAKE_ID,
    kindoo_site_id: SITE_FOREIGN,
    last_seen_at: SERVER_TIMESTAMP(),
    kindoo_eid: 4242,
    kindoo_site_name: 'Oak Site',
    ext_version: '2.5.0',
    lastActor: lastActorOf(OWNER),
    ...overrides,
  };
}

/** Admin-seeded form — `serverTimestamp()` isn't needed off the client path. */
function seededDesktop(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return desktopDoc({ last_seen_at: new Date(), ...overrides });
}

/** Exactly what the phone writes on tap. */
function queuedJob(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    request_id: 'req-1',
    stake_id: STAKE_ID,
    target_site_key: SITE_HOME,
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
        target_site_key: SITE_HOME,
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
        await ctx.firestore().doc(PRESENCE_PATH).set(presenceDoc());
      });
      await assertSucceeds(managerContext(env, STAKE_ID).firestore().doc(PRESENCE_PATH).get());
    });

    it('anonymous read denied', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx.firestore().doc(PRESENCE_PATH).set(presenceDoc());
      });
      await assertFails(unauthedContext(env).firestore().doc(PRESENCE_PATH).get());
    });

    it("another authed user is denied a read of the owner's presence doc", async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx.firestore().doc(PRESENCE_PATH).set(presenceDoc());
      });
      await assertFails(stakeMemberContext(env, STAKE_ID).firestore().doc(PRESENCE_PATH).get());
    });

    it('manager creates their own presence doc', async () => {
      const db = managerContext(env, STAKE_ID).firestore();
      await assertSucceeds(db.doc(PRESENCE_PATH).set(presenceDoc()));
    });

    it('manager rewrites (heartbeats) their own presence doc', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx.firestore().doc(PRESENCE_PATH).set(presenceDoc());
      });
      const db = managerContext(env, STAKE_ID).firestore();
      await assertSucceeds(db.doc(PRESENCE_PATH).set(presenceDoc({ ext_version: '2.6.0' })));
    });

    it('presence doc accepts an absent remote_apply_enabled (reads as opted out)', async () => {
      const db = managerContext(env, STAKE_ID).firestore();
      const { remote_apply_enabled: _omit, ...withoutFlag } = presenceDoc();
      await assertSucceeds(db.doc(PRESENCE_PATH).set(withoutFlag));
    });

    it('turning the toggle off (opting out) is an ordinary update', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx.firestore().doc(PRESENCE_PATH).set(presenceDoc());
      });
      const db = managerContext(env, STAKE_ID).firestore();
      await assertSucceeds(
        db.doc(PRESENCE_PATH).update({
          remote_apply_enabled: false,
          lastActor: lastActorOf(OWNER),
        }),
      );
    });

    it('the retired per-site fields are rejected', async () => {
      // These moved to `desktops/{siteId}`. The check matters for more
      // than tidiness: it is what makes a `setDoc(..., {merge: true})`
      // over a doc still carrying the old shape fail loudly instead of
      // leaving a half-migrated presence doc behind.
      const db = managerContext(env, STAKE_ID).firestore();
      await assertFails(db.doc(PRESENCE_PATH).set(presenceDoc({ stake_id: STAKE_ID })));
      await assertFails(
        db.doc(PRESENCE_PATH).set(presenceDoc({ last_seen_at: SERVER_TIMESTAMP() })),
      );
      await assertFails(db.doc(PRESENCE_PATH).set(presenceDoc({ kindoo_eid: 4242 })));
      await assertFails(db.doc(PRESENCE_PATH).set(presenceDoc({ kindoo_site_name: 'Maple Site' })));
    });

    it("manager is denied a write to another member's presence doc", async () => {
      const db = managerContext(env, STAKE_ID).firestore();
      await assertFails(db.doc(`remoteApply/${personas.stakeMember.canonical}`).set(presenceDoc()));
    });

    it('a non-manager MAY write their own presence doc — it grants nothing', async () => {
      // Deliberate loosening. The doc used to carry `stake_id` and the
      // rule gated on `isManager(stake_id)`; the field moved down to
      // `desktops` and there is no way to ask rules "is this user a
      // manager of any stake at all". Dropping the gate is safe because
      // the doc is inert on its own: the `desktops` and `jobs` writes
      // below still carry a `stake_id` and still gate on it, so this
      // user has published consent to use a desktop they cannot register
      // and cannot queue work for. The exact three-key shape plus the
      // `ext_version` length cap is what bounds the storage.
      const db = stakeMemberContext(env, STAKE_ID).firestore();
      await assertSucceeds(
        db
          .doc(`remoteApply/${personas.stakeMember.canonical}`)
          .set(presenceDoc({ lastActor: lastActorOf(personas.stakeMember) })),
      );
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
    });

    it('an oversized ext_version is denied (the storage bound on an ungated doc)', async () => {
      const db = managerContext(env, STAKE_ID).firestore();
      await assertFails(db.doc(PRESENCE_PATH).set(presenceDoc({ ext_version: 'v'.repeat(33) })));
      // A realistic four-part manifest version is nowhere near the cap.
      await assertSucceeds(db.doc(PRESENCE_PATH).set(presenceDoc({ ext_version: '12.34.56.789' })));
    });

    it('presence doc delete is denied (opting out clears the flag instead)', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx.firestore().doc(PRESENCE_PATH).set(presenceDoc());
      });
      await assertFails(managerContext(env, STAKE_ID).firestore().doc(PRESENCE_PATH).delete());
    });
  });

  // One doc per live Kindoo tab, keyed by the site that tab is inside.
  // The coexistence test is the reason this collection exists at all.
  describe('desktops', () => {
    it('two tabs on two sites both publish, and neither clobbers the other', async () => {
      const tabHome = managerContext(env, STAKE_ID).firestore();
      const tabForeign = managerContext(env, STAKE_ID).firestore();

      // The home tab: reserved key as the doc id, null as the body's
      // `kindoo_site_id`. The foreign tab: its `kindooSites` slug in both.
      await assertSucceeds(
        tabHome.doc(desktopPath(SITE_HOME)).set(
          desktopDoc({
            kindoo_site_id: null,
            kindoo_eid: 4242,
            kindoo_site_name: 'Maple Site',
          }),
        ),
      );
      await assertSucceeds(
        tabForeign.doc(desktopPath(SITE_FOREIGN)).set(
          desktopDoc({
            kindoo_site_id: SITE_FOREIGN,
            kindoo_eid: 8080,
            kindoo_site_name: 'Oak Site',
          }),
        ),
      );

      // Both survive: the old one-doc shape lost the first tab's EID on
      // the second tab's next heartbeat.
      const snap = await managerContext(env, STAKE_ID).firestore().collection(DESKTOPS_PATH).get();
      expect(snap.docs.map((d) => d.id).sort()).toEqual([SITE_FOREIGN, SITE_HOME].sort());
      expect(snap.docs.find((d) => d.id === SITE_HOME)?.data()['kindoo_eid']).toBe(4242);
      expect(snap.docs.find((d) => d.id === SITE_FOREIGN)?.data()['kindoo_eid']).toBe(8080);

      // And each keeps heartbeating independently.
      await assertSucceeds(
        tabHome.doc(desktopPath(SITE_HOME)).set(desktopDoc({ kindoo_site_id: null })),
      );
      await assertSucceeds(tabForeign.doc(desktopPath(SITE_FOREIGN)).set(desktopDoc()));
    });

    it('owner reads and lists their own desktops', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx.firestore().doc(desktopPath(SITE_HOME)).set(seededDesktop());
      });
      const db = managerContext(env, STAKE_ID).firestore();
      await assertSucceeds(db.doc(desktopPath(SITE_HOME)).get());
      // The phone reads the whole (tiny) collection and filters for
      // freshness in memory — no filter, no index.
      await assertSucceeds(db.collection(DESKTOPS_PATH).get());
    });

    it('anonymous read denied', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx.firestore().doc(desktopPath(SITE_HOME)).set(seededDesktop());
      });
      await assertFails(unauthedContext(env).firestore().doc(desktopPath(SITE_HOME)).get());
    });

    it("another authed user is denied reads and lists of the owner's desktops", async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx.firestore().doc(desktopPath(SITE_HOME)).set(seededDesktop());
      });
      const db = stakeMemberContext(env, STAKE_ID).firestore();
      await assertFails(db.doc(desktopPath(SITE_HOME)).get());
      await assertFails(db.collection(DESKTOPS_PATH).get());
    });

    it('a heartbeat over an existing desktop doc is allowed', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx.firestore().doc(desktopPath(SITE_HOME)).set(seededDesktop());
      });
      const db = managerContext(env, STAKE_ID).firestore();
      await assertSucceeds(
        db.doc(desktopPath(SITE_HOME)).update({
          last_seen_at: SERVER_TIMESTAMP(),
          lastActor: lastActorOf(OWNER),
        }),
      );
    });

    it('a desktop doc accepts a null eid / site name (tab online, site unresolved)', async () => {
      const db = managerContext(env, STAKE_ID).firestore();
      await assertSucceeds(
        db
          .doc(desktopPath(SITE_HOME))
          .set(desktopDoc({ kindoo_eid: null, kindoo_site_name: null })),
      );
    });

    it('a null kindoo_site_id is accepted — that is how home spells itself', async () => {
      const db = managerContext(env, STAKE_ID).firestore();
      await assertSucceeds(
        db.doc(desktopPath(SITE_HOME)).set(desktopDoc({ kindoo_site_id: null })),
      );
    });

    it('the rules do not require the doc id and kindoo_site_id to agree', async () => {
      // Documented non-enforcement. The two are related through
      // `remoteApplySiteKey` (null ↔ 'home'), which rules can't express
      // without pinning the shared home key in a second place. Keeping
      // them paired is the extension's job; a mismatch misroutes only
      // this manager's own jobs.
      const db = managerContext(env, STAKE_ID).firestore();
      await assertSucceeds(
        db.doc(desktopPath(SITE_HOME)).set(desktopDoc({ kindoo_site_id: SITE_FOREIGN })),
      );
    });

    it('the owner may delete their own desktop doc (immediate opt-out)', async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx.firestore().doc(desktopPath(SITE_HOME)).set(seededDesktop());
      });
      // Retracting presence beats waiting out REMOTE_APPLY_STALE_MS,
      // during which the phone would keep naming this site as covered.
      await assertSucceeds(
        managerContext(env, STAKE_ID).firestore().doc(desktopPath(SITE_HOME)).delete(),
      );
    });

    it("another authed user is denied a delete of the owner's desktop doc", async () => {
      await seedAsAdmin(env, async (ctx) => {
        await ctx.firestore().doc(desktopPath(SITE_HOME)).set(seededDesktop());
      });
      await assertFails(
        stakeMemberContext(env, STAKE_ID).firestore().doc(desktopPath(SITE_HOME)).delete(),
      );
    });

    it("manager is denied a write to another member's desktops", async () => {
      const db = managerContext(env, STAKE_ID).firestore();
      await assertFails(
        db
          .doc(`remoteApply/${personas.stakeMember.canonical}/desktops/${SITE_HOME}`)
          .set(desktopDoc()),
      );
    });

    it('non-manager is denied a desktops write in their own mailbox', async () => {
      // The gate the parent presence doc gave up lives here. Registering
      // a desktop is what makes the phone offer the button, so it has to
      // prove a manager claim on the stake it names.
      const db = stakeMemberContext(env, STAKE_ID).firestore();
      await assertFails(
        db
          .doc(`remoteApply/${personas.stakeMember.canonical}/desktops/${SITE_HOME}`)
          .set(desktopDoc({ lastActor: lastActorOf(personas.stakeMember) })),
      );
    });

    it('a desktop doc naming a stake the writer does not manage is denied', async () => {
      const db = managerContext(env, STAKE_ID).firestore();
      await assertFails(
        db.doc(desktopPath(SITE_HOME)).set(desktopDoc({ stake_id: FOREIGN_STAKE_ID })),
      );
    });

    it('a desktop doc with a mismatched lastActor is denied', async () => {
      const db = managerContext(env, STAKE_ID).firestore();
      await assertFails(
        db.doc(desktopPath(SITE_HOME)).set(
          desktopDoc({
            lastActor: { email: 'Mallory@gmail.com', canonical: 'mallory@gmail.com' },
          }),
        ),
      );
    });

    it('a desktop doc carrying an unknown field is denied', async () => {
      const db = managerContext(env, STAKE_ID).firestore();
      await assertFails(db.doc(desktopPath(SITE_HOME)).set(desktopDoc({ smuggled: 'payload' })));
    });

    it('a desktop doc missing a required field is denied', async () => {
      const db = managerContext(env, STAKE_ID).firestore();
      // `kindoo_site_id` is required-but-nullable: null is a value, so
      // omitting the key is still a denial.
      for (const field of [
        'stake_id',
        'kindoo_site_id',
        'last_seen_at',
        'kindoo_eid',
        'kindoo_site_name',
        'ext_version',
      ]) {
        const { [field]: _omit, ...without } = desktopDoc();
        await assertFails(db.doc(desktopPath(SITE_HOME)).set(without));
      }
    });

    it('a desktop doc with a mistyped field is denied', async () => {
      const db = managerContext(env, STAKE_ID).firestore();
      await assertFails(db.doc(desktopPath(SITE_HOME)).set(desktopDoc({ kindoo_eid: 'eid-4242' })));
      await assertFails(db.doc(desktopPath(SITE_HOME)).set(desktopDoc({ ext_version: 3 })));
      await assertFails(db.doc(desktopPath(SITE_HOME)).set(desktopDoc({ stake_id: 42 })));
      await assertFails(db.doc(desktopPath(SITE_HOME)).set(desktopDoc({ kindoo_site_id: 42 })));
      await assertFails(db.doc(desktopPath(SITE_HOME)).set(desktopDoc({ kindoo_site_name: 99 })));
      await assertFails(
        db.doc(desktopPath(SITE_HOME)).set(desktopDoc({ last_seen_at: 'yesterday' })),
      );
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
      // The extension's poller: one equality filter, then
      // `canClaimRemoteApplyJob` in memory over the handful returned.
      // Still no composite index.
      await assertSucceeds(
        db.collection(JOBS_PATH).where('status', '==', 'queued').limit(20).get(),
      );
      // And if the poller ever narrows to its own site server-side:
      // two equality filters with no orderBy are served by merging the
      // automatic single-field indexes, so that needs no composite
      // either. Only adding an orderBy on a third field would.
      await assertSucceeds(
        db
          .collection(JOBS_PATH)
          .where('status', '==', 'queued')
          .where('target_site_key', '==', SITE_HOME)
          .get(),
      );
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

    it('create targeting either a foreign site or home is allowed', async () => {
      const db = managerContext(env, STAKE_ID).firestore();
      await assertSucceeds(db.doc(JOB_PATH).set(queuedJob({ target_site_key: SITE_FOREIGN })));
      await clearAll(env);
      // Home is a site key like any other — there is no null / "any
      // site" spelling, which is what makes the desktop match exact.
      await assertSucceeds(db.doc(JOB_PATH).set(queuedJob({ target_site_key: SITE_HOME })));
    });

    it('create omitting target_site_key is denied', async () => {
      // Required, not optional: a phone that can't resolve the target
      // site can't know which desktop could serve the job, so it must
      // not queue one at all.
      const db = managerContext(env, STAKE_ID).firestore();
      const { target_site_key: _omit, ...withoutSite } = queuedJob();
      await assertFails(db.doc(JOB_PATH).set(withoutSite));
    });

    it('create with a null, empty, or mistyped target_site_key is denied', async () => {
      const db = managerContext(env, STAKE_ID).firestore();
      await assertFails(db.doc(JOB_PATH).set(queuedJob({ target_site_key: null })));
      // Null and empty both name a site no tab can ever be inside, so
      // the job would sit unclaimable until the phone timed it out.
      await assertFails(db.doc(JOB_PATH).set(queuedJob({ target_site_key: '' })));
      await assertFails(db.doc(JOB_PATH).set(queuedJob({ target_site_key: 4242 })));
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

    // A job with no `target_site_key` cannot be created through the
    // rules at all, and no Cloud Function writes this collection, so
    // one can only exist as leftover test data from before the field
    // was required. Such a doc is INERT: `jobCoreUnchanged` reads the
    // field bare, and a bare read of a missing key errors, so every
    // transition — claim, cancel, report — is denied.
    //
    // That is the safe failure. The target site of such a job is
    // unknowable, and claiming it would run a real provision in Kindoo
    // against a guessed site. Frozen-and-visible beats applied-to-the-
    // wrong-place. Clients therefore do NOT need to defend against the
    // missing field; leftovers need deleting, not defaulting.
    it('a job with no target_site_key is frozen, not claimable', async () => {
      await seedAsAdmin(env, async (ctx) => {
        const { target_site_key: _omit, ...withoutSite } = queuedJob();
        await ctx
          .firestore()
          .doc(JOB_PATH)
          .set({ ...withoutSite, created_at: new Date() });
      });
      const db = managerContext(env, STAKE_ID).firestore();
      await assertFails(db.doc(JOB_PATH).update(claimPayload()));
      // Not even the phone's cancel can move it.
      await assertFails(
        db.doc(JOB_PATH).update({
          status: 'cancelled',
          finished_at: SERVER_TIMESTAMP(),
          lastActor: lastActorOf(OWNER),
        }),
      );
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

    // `target_site_key` decides WHICH desktop may claim the job, so a
    // mutable one would let a tab retarget work to itself and run a
    // provision against the wrong Kindoo site. It has to hold across
    // every transition, not just the claim.
    it('target_site_key cannot be rewritten on any transition', async () => {
      const db = managerContext(env, STAKE_ID).firestore();

      // queued → running (the claim).
      await seedJob(env, { status: 'queued', target_site_key: SITE_HOME });
      await assertFails(db.doc(JOB_PATH).update(claimPayload({ target_site_key: SITE_FOREIGN })));
      await clearAll(env);

      // queued → cancelled (the phone's timeout).
      await seedJob(env, { status: 'queued', target_site_key: SITE_HOME });
      await assertFails(
        db.doc(JOB_PATH).update({
          status: 'cancelled',
          finished_at: SERVER_TIMESTAMP(),
          target_site_key: SITE_FOREIGN,
          lastActor: lastActorOf(OWNER),
        }),
      );
      await clearAll(env);

      // running → terminal (the report-back).
      await seedJob(env, { status: 'running', target_site_key: SITE_HOME });
      await assertFails(
        db.doc(JOB_PATH).update(finishPayload('applied', { target_site_key: SITE_FOREIGN })),
      );
    });

    it('target_site_key cannot be nulled or deleted mid-flight', async () => {
      const db = managerContext(env, STAKE_ID).firestore();

      await seedJob(env, { status: 'queued', target_site_key: SITE_HOME });
      await assertFails(db.doc(JOB_PATH).update(claimPayload({ target_site_key: null })));
      await clearAll(env);

      // Removing the field would strand the job with no site to match
      // against — the same retarget by another route.
      await seedJob(env, { status: 'queued', target_site_key: SITE_HOME });
      await assertFails(
        db.doc(JOB_PATH).update({
          ...claimPayload(),
          target_site_key: firebase.firestore.FieldValue.delete(),
        }),
      );
    });

    it('a job transitions normally when target_site_key is left alone', async () => {
      const db = managerContext(env, STAKE_ID).firestore();
      await seedJob(env, { status: 'queued', target_site_key: SITE_FOREIGN });
      await assertSucceeds(db.doc(JOB_PATH).update(claimPayload()));
      await assertSucceeds(db.doc(JOB_PATH).update(finishPayload('applied')));
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
