// Service-worker-side Firestore reads + writes for the v2.1
// configuration flow. The content-script panel cannot touch Firestore
// directly (no SDK; no auth token from this context); it round-trips
// through these handlers.
//
// Operations:
//   - `loadStakeConfig()`           — one-shot read of stake + buildings +
//                                     wards + kindooSites
//   - `writeKindooConfig(payload)`  — single batched write across stake +
//                                     building docs
//   - `writeKindooSiteEid(...)`     — auto-populate `kindoo_eid` on a
//                                     foreign `KindooSite` doc (Kindoo
//                                     Sites Phase 3 — see spec §15)
//
// Both run under the SW's Firebase Auth session — the same one that
// signs the v1 callable invocations. Firestore rules gate the actual
// authorisation.

import {
  collection,
  doc,
  getDoc,
  getDocs,
  serverTimestamp,
  updateDoc,
  writeBatch,
} from 'firebase/firestore';
import type {
  Building,
  KindooSite,
  Seat,
  Stake,
  StakeCallingTemplate,
  Ward,
  WardCallingTemplate,
} from '@kindoo/shared';
import { canonicalEmail } from '@kindoo/shared';
import type { User } from 'firebase/auth/web-extension';
import { firestore } from '../lib/firebase';
import { STAKE_ID } from '../lib/constants';
import type { WriteKindooConfigPayload } from '../lib/messaging';

interface StakeConfigBundle {
  stake: Stake;
  buildings: Building[];
  wards: Ward[];
  /**
   * Foreign Kindoo sites configured for this stake. Empty when the
   * stake only operates its home site. Kindoo Sites Phase 3 reads
   * these in the extension's orchestrator to validate that the active
   * Kindoo session's EID matches the request's target site.
   */
  kindooSites: KindooSite[];
}

export interface SyncDataBundle {
  stake: Stake;
  wards: Ward[];
  buildings: Building[];
  seats: Seat[];
  wardCallingTemplates: WardCallingTemplate[];
  stakeCallingTemplates: StakeCallingTemplate[];
  /**
   * Foreign Kindoo sites under `stakes/{STAKE_ID}/kindooSites/*`. The
   * Sync feature filters its comparison to seats / users on the
   * currently-active Kindoo site (see `content/kindoo/sync/activeSite.ts`).
   * Empty for stakes that operate only the home Kindoo site.
   */
  kindooSites: KindooSite[];
}

/**
 * One-shot read of `stakes/{STAKE_ID}` plus every doc under
 * `stakes/{STAKE_ID}/buildings/*`, `stakes/{STAKE_ID}/wards/*`, and
 * `stakes/{STAKE_ID}/kindooSites/*`. Buildings sorted by name (stable
 * order in the v2.1 wizard); wards sorted by code (stable order for
 * v2.2 ward-scope resolution); kindooSites sorted by display_name for
 * predictable surfacing if a UI ever lists them inline.
 */
export async function loadStakeConfig(): Promise<StakeConfigBundle> {
  const db = firestore();
  const stakeRef = doc(db, 'stakes', STAKE_ID);

  const [stakeSnap, buildingsSnap, wardsSnap, kindooSitesSnap] = await Promise.all([
    getDoc(stakeRef),
    getDocs(collection(db, 'stakes', STAKE_ID, 'buildings')),
    getDocs(collection(db, 'stakes', STAKE_ID, 'wards')),
    getDocs(collection(db, 'stakes', STAKE_ID, 'kindooSites')),
  ]);

  if (!stakeSnap.exists()) {
    throw new Error(`stake doc ${STAKE_ID} not found`);
  }
  const stake = stakeSnap.data() as Stake;

  const buildings = buildingsSnap.docs.map((d) => d.data() as Building);
  buildings.sort((a, b) => a.building_name.localeCompare(b.building_name));

  const wards = wardsSnap.docs.map((d) => d.data() as Ward);
  wards.sort((a, b) => a.ward_code.localeCompare(b.ward_code));

  const kindooSites = kindooSitesSnap.docs.map((d) => d.data() as KindooSite);
  kindooSites.sort((a, b) => a.display_name.localeCompare(b.display_name));

  return { stake, buildings, wards, kindooSites };
}

/**
 * Auto-populate `kindoo_eid` on a foreign `KindooSite` doc. The
 * extension calls this when an operator is about to run a provision
 * against a foreign site that has no EID recorded yet AND the active
 * Kindoo session's site name matches the foreign site's
 * `kindoo_expected_site_name`. Manager-only by Firestore rules
 * (`kindooSites/{id}` write rule gates on `isManager(stakeId)`); the
 * extension's caller is already a manager — the runtime check is just
 * defense in depth. See spec §15.
 *
 * Home-collision guard: read the stake doc first and refuse if the
 * caller is trying to persist the home `kindoo_config.site_id` onto a
 * foreign-site doc. The orchestrator's `checkRequestSite` already
 * gates this at the entry; this writer-side check is belts-and-braces
 * so a hypothetical buggy caller can't smuggle HOME_EID into a foreign
 * doc and permanently bypass Phase 3.
 *
 * Non-home overwrite guard: if the target doc already carries a
 * `kindoo_eid` that differs from the incoming value, refuse. The only
 * caller of this writer is `RequestCard.tsx` after `checkRequestSite`
 * returns a `populate` instruction; by construction that path only
 * fires on docs whose `kindoo_eid` is null / undefined, so the
 * idempotent same-value re-assert is reachable here only via a race
 * (concurrent populate). The guard regression-proofs against a buggy /
 * future caller silently rewriting an established foreign-site
 * `kindoo_eid` and re-routing door-access for the foreign ward. The
 * symmetric guard for the wizard's foreign-save path lives in
 * `writeKindooConfig` below.
 */
export async function writeKindooSiteEid(
  kindooSiteId: string,
  kindooEid: number,
  actor: User,
): Promise<void> {
  if (!actor.email) {
    throw new Error('signed-in user has no email; cannot write actor ref');
  }
  const actorRef = {
    email: actor.email,
    canonical: canonicalEmail(actor.email),
  };
  const db = firestore();
  const stakeRef = doc(db, 'stakes', STAKE_ID);
  const stakeSnap = await getDoc(stakeRef);
  const homeSiteId = stakeSnap.exists()
    ? ((stakeSnap.data() as Stake).kindoo_config?.site_id ?? null)
    : null;
  if (homeSiteId !== null && homeSiteId === kindooEid) {
    throw new Error(
      `refusing to write home kindoo_config.site_id (${kindooEid}) onto foreign ` +
        `KindooSite '${kindooSiteId}'; this would trap HOME_EID on the foreign doc`,
    );
  }
  const siteRef = doc(db, 'stakes', STAKE_ID, 'kindooSites', kindooSiteId);
  const siteSnap = await getDoc(siteRef);
  const existingEid = siteSnap.exists()
    ? ((siteSnap.data() as KindooSite).kindoo_eid ?? null)
    : null;
  if (existingEid !== null && existingEid !== kindooEid) {
    throw new Error(
      `Refusing to overwrite existing kindoo_eid for site '${kindooSiteId}' ` +
        `(existing=${existingEid}, incoming=${kindooEid}).`,
    );
  }
  await updateDoc(siteRef, {
    kindoo_eid: kindooEid,
    last_modified_at: serverTimestamp(),
    lastActor: actorRef,
  });
}

/**
 * Persist the v2.1 / Phase 5 configuration in a single batched write.
 *
 * The wizard runs once per Kindoo site — home OR a specific foreign
 * site. The site is discriminated by `payload.kindooSiteId`:
 *
 *  - `null` (home) — write `stake.kindoo_config` + per-building
 *    `kindoo_rule` on the supplied home buildings.
 *  - `<string>` (foreign) — auto-populate `kindoo_eid` on
 *    `kindooSites/{id}` + per-building `kindoo_rule` on the supplied
 *    foreign-site buildings. The stake doc is NOT touched (its
 *    `kindoo_config` is home's identity and would be clobbered).
 *
 * `lastActor` + `last_modified_at` get bumped on every doc the batch
 * writes, per the rules' integrity contract.
 */
export async function writeKindooConfig(
  payload: WriteKindooConfigPayload,
  actor: User,
): Promise<void> {
  if (!actor.email) {
    throw new Error('signed-in user has no email; cannot write actor ref');
  }
  const actorRef = {
    email: actor.email,
    canonical: canonicalEmail(actor.email),
  };
  const db = firestore();
  const batch = writeBatch(db);

  if (payload.kindooSiteId === null) {
    // Home save — writes stake.kindoo_config alongside the per-building
    // rule rows. Defensive read first: if the wizard couldn't resolve
    // a fresh site name (env missing from a Kindoo paginated/transient
    // /Environments response), preserve the existing
    // `kindoo_config.site_name` rather than clobbering it with ''.
    // The site-check resolver returns `home` purely by EID compare, so
    // a re-configure of a valid home is legitimate even when
    // getEnvironments() doesn't list the active env.
    //
    // Symmetric home-collision guard: read foreign kindooSites and
    // refuse when payload.siteId matches any foreign `kindoo_eid` —
    // mirror of the orchestrator-entry guard in `siteCheck.ts`. Without
    // this, a buggy resolver (e.g. ambiguous-name fallthrough) could
    // persist FOREIGN_EID as the home `kindoo_config.site_id` and
    // permanently misconfigure home.
    //
    // Dotted-path writes on `kindoo_config.*`: a top-level
    // `kindoo_config: {…}` update would REPLACE the whole map, dropping
    // any field that exists today but isn't in the literal — and any
    // field future phases add. Phase 5 runs this writer on every
    // re-configure, so the partial-merge shape is load-bearing.
    const stakeRef = doc(db, 'stakes', STAKE_ID);
    const kindooSitesSnap = await getDocs(collection(db, 'stakes', STAKE_ID, 'kindooSites'));
    const foreignEids = kindooSitesSnap.docs
      .map((d) => (d.data() as KindooSite).kindoo_eid)
      .filter((eid): eid is number => eid !== undefined && eid !== null);
    if (foreignEids.includes(payload.siteId)) {
      throw new Error(
        `refusing to write foreign kindoo_eid (${payload.siteId}) as home ` +
          `kindoo_config.site_id; this would trap FOREIGN_EID on the stake doc`,
      );
    }
    let siteName = payload.siteName;
    if (!siteName) {
      const stakeSnap = await getDoc(stakeRef);
      const existing = stakeSnap.exists()
        ? ((stakeSnap.data() as Stake).kindoo_config?.site_name ?? '')
        : '';
      siteName = existing;
    }
    batch.update(stakeRef, {
      'kindoo_config.site_id': payload.siteId,
      'kindoo_config.site_name': siteName,
      'kindoo_config.configured_at': serverTimestamp(),
      'kindoo_config.configured_by': actorRef,
      last_modified_at: serverTimestamp(),
      lastActor: actorRef,
    });
  } else {
    // Foreign save — write the discovered EID onto the foreign site
    // doc. Idempotent: re-running the wizard against the same site
    // with `kindoo_eid` already set just re-asserts the value.
    //
    // Home-collision guard: refuse if the about-to-be-written foreign
    // EID equals the home `kindoo_config.site_id`. This belts-and-
    // braces the orchestrator-entry guard in `siteCheck.ts` — even a
    // buggy caller can't smuggle HOME_EID into a foreign doc.
    //
    // Non-home overwrite guard (symmetric to writeKindooSiteEid above):
    // if the target doc already carries a `kindoo_eid` that differs from
    // the incoming value, refuse. Concrete scenario: foreign doc carries
    // EID X; a Kindoo-side rename causes `resolveActiveKindooSite` to
    // match by name and return `populateEid: Y` even though the doc
    // already has X. Without this guard the wizard's save would silently
    // overwrite X with Y and re-route door access for that foreign ward.
    // Re-asserting an identical value is still allowed.
    const stakeRef = doc(db, 'stakes', STAKE_ID);
    const stakeSnap = await getDoc(stakeRef);
    const homeSiteId = stakeSnap.exists()
      ? ((stakeSnap.data() as Stake).kindoo_config?.site_id ?? null)
      : null;
    if (homeSiteId !== null && homeSiteId === payload.siteId) {
      throw new Error(
        `refusing to write home kindoo_config.site_id (${payload.siteId}) onto foreign ` +
          `KindooSite '${payload.kindooSiteId}'; this would trap HOME_EID on the foreign doc`,
      );
    }
    const foreignRef = doc(db, 'stakes', STAKE_ID, 'kindooSites', payload.kindooSiteId);
    const foreignSnap = await getDoc(foreignRef);
    const existingEid = foreignSnap.exists()
      ? ((foreignSnap.data() as KindooSite).kindoo_eid ?? null)
      : null;
    if (existingEid !== null && existingEid !== payload.siteId) {
      throw new Error(
        `Refusing to overwrite existing kindoo_eid for site '${payload.kindooSiteId}' ` +
          `(existing=${existingEid}, incoming=${payload.siteId}).`,
      );
    }
    batch.update(foreignRef, {
      kindoo_eid: payload.siteId,
      last_modified_at: serverTimestamp(),
      lastActor: actorRef,
    });
  }

  for (const row of payload.buildingRules) {
    const buildingRef = doc(db, 'stakes', STAKE_ID, 'buildings', row.buildingId);
    batch.update(buildingRef, {
      kindoo_rule: {
        rule_id: row.ruleId,
        rule_name: row.ruleName,
      },
      last_modified_at: serverTimestamp(),
      lastActor: actorRef,
    });
  }

  await batch.commit();
}

/**
 * One-shot read of every collection the Sync feature needs. Stake doc
 * + wards + buildings + seats + ward calling templates + stake calling
 * templates, fetched in parallel via `Promise.all`.
 *
 * Firestore rules gate read authorisation; non-managers get a
 * permission-denied that surfaces back through the SW message
 * pipeline.
 */
export async function loadSyncData(): Promise<SyncDataBundle> {
  const db = firestore();
  const stakeRef = doc(db, 'stakes', STAKE_ID);

  const [
    stakeSnap,
    wardsSnap,
    buildingsSnap,
    seatsSnap,
    wardTemplatesSnap,
    stakeTemplatesSnap,
    kindooSitesSnap,
  ] = await Promise.all([
    getDoc(stakeRef),
    getDocs(collection(db, 'stakes', STAKE_ID, 'wards')),
    getDocs(collection(db, 'stakes', STAKE_ID, 'buildings')),
    getDocs(collection(db, 'stakes', STAKE_ID, 'seats')),
    getDocs(collection(db, 'stakes', STAKE_ID, 'wardCallingTemplates')),
    getDocs(collection(db, 'stakes', STAKE_ID, 'stakeCallingTemplates')),
    getDocs(collection(db, 'stakes', STAKE_ID, 'kindooSites')),
  ]);

  if (!stakeSnap.exists()) {
    throw new Error(`stake doc ${STAKE_ID} not found`);
  }
  const stake = stakeSnap.data() as Stake;
  const wards = wardsSnap.docs.map((d) => d.data() as Ward);
  const buildings = buildingsSnap.docs.map((d) => d.data() as Building);
  const seats = seatsSnap.docs.map((d) => d.data() as Seat);
  const wardCallingTemplates = wardTemplatesSnap.docs.map((d) => d.data() as WardCallingTemplate);
  const stakeCallingTemplates = stakeTemplatesSnap.docs.map(
    (d) => d.data() as StakeCallingTemplate,
  );
  const kindooSites = kindooSitesSnap.docs.map((d) => d.data() as KindooSite);

  return {
    stake,
    wards,
    buildings,
    seats,
    wardCallingTemplates,
    stakeCallingTemplates,
    kindooSites,
  };
}

/**
 * One-shot read of `stakes/{STAKE_ID}/seats/{canonical}`. Returns
 * `null` when the seat doesn't exist (first-time-add cases).
 * Firestore rules gate read authorisation; non-managers get a
 * permission-denied that surfaces back through the SW message
 * pipeline.
 */
export async function loadSeatByEmail(canonical: string): Promise<Seat | null> {
  const db = firestore();
  const seatRef = doc(db, 'stakes', STAKE_ID, 'seats', canonical);
  const snap = await getDoc(seatRef);
  if (!snap.exists()) return null;
  return snap.data() as Seat;
}
