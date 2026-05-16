// Service-worker-side Firestore reads + writes for the v2.1
// configuration flow. The content-script panel cannot touch Firestore
// directly (no SDK; no auth token from this context); it round-trips
// through these handlers.
//
// Two operations:
//   - `loadStakeConfig()`           — one-shot read of stake + buildings
//   - `writeKindooConfig(payload)`  — single batched write across stake +
//                                     building docs
//
// Both run under the SW's Firebase Auth session — the same one that
// signs the v1 callable invocations. Firestore rules gate the actual
// authorisation.

import { collection, doc, getDoc, getDocs, serverTimestamp, writeBatch } from 'firebase/firestore';
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
 * `stakes/{STAKE_ID}/buildings/*` and `stakes/{STAKE_ID}/wards/*`.
 * Buildings sorted by name (stable order in the v2.1 wizard);
 * wards sorted by code (stable order for v2.2 ward-scope resolution).
 */
export async function loadStakeConfig(): Promise<StakeConfigBundle> {
  const db = firestore();
  const stakeRef = doc(db, 'stakes', STAKE_ID);
  const stakeSnap = await getDoc(stakeRef);
  if (!stakeSnap.exists()) {
    throw new Error(`stake doc ${STAKE_ID} not found`);
  }
  const stake = stakeSnap.data() as Stake;

  const buildingsCol = collection(db, 'stakes', STAKE_ID, 'buildings');
  const buildingsSnap = await getDocs(buildingsCol);
  const buildings = buildingsSnap.docs.map((d) => d.data() as Building);
  buildings.sort((a, b) => a.building_name.localeCompare(b.building_name));

  const wardsCol = collection(db, 'stakes', STAKE_ID, 'wards');
  const wardsSnap = await getDocs(wardsCol);
  const wards = wardsSnap.docs.map((d) => d.data() as Ward);
  wards.sort((a, b) => a.ward_code.localeCompare(b.ward_code));

  return { stake, buildings, wards };
}

/**
 * Persist the v2.1 configuration in a single batched write. Stake doc
 * gets the new `kindoo_config` field; every building doc named in
 * `payload.buildingRules` gets `kindoo_rule`. `lastActor` and
 * `last_modified_at` are touched on every affected doc per the
 * rules' integrity contract.
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

  const stakeRef = doc(db, 'stakes', STAKE_ID);
  batch.update(stakeRef, {
    kindoo_config: {
      site_id: payload.siteId,
      site_name: payload.siteName,
      configured_at: serverTimestamp(),
      configured_by: actorRef,
    },
    last_modified_at: serverTimestamp(),
    lastActor: actorRef,
  });

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
