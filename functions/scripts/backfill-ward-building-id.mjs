#!/usr/bin/env node
// One-time ward-backfill migration (T-67): populate the additive
// `ward.building_id` slug FK from the ward's existing `building_name`.
//
// The ward→building reference is additive + backward-compatible:
// `building_name` stays required + populated, and `resolveWardBuilding`
// reads `building_id` first with a `building_name` fallback. So this
// migration is NOT required for correctness — un-migrated wards keep
// resolving via the name fallback. It only populates the new field so the
// slug FK becomes the primary reference and survives a building rename.
//
// For every ward in every stake whose `building_id` is absent, find the
// building whose `building_name === ward.building_name` and set
// `ward.building_id = building.building_id`. Wards whose `building_name`
// matches no building are logged + counted (an unmatched flag) so the
// operator can fix the data; they are left untouched.
//
// `lastActor` is left untouched: this is a server-side field-population
// only. The write does not pass through Firestore rules (Admin SDK), and
// the parameterized `auditTrigger` (which keys on the audited
// collections) does not fan ward writes, so no synthetic actor is needed.
//
// ── Operator run command ──────────────────────────────────────────────
// Auth via Application Default Credentials. Run staging first, eyeball
// the summary + any UNMATCHED lines, then run prod.
//
//   gcloud auth application-default login        # once per machine
//
//   # 1. Dry run against staging (no writes; prints planned changes):
//   GOOGLE_CLOUD_PROJECT=kindoo-staging \
//     node functions/scripts/backfill-ward-building-id.mjs --dry-run
//
//   # 2. Apply against staging:
//   GOOGLE_CLOUD_PROJECT=kindoo-staging \
//     node functions/scripts/backfill-ward-building-id.mjs
//
//   # 3. Repeat (1) then (2) with GOOGLE_CLOUD_PROJECT=kindoo-prod.
//
// Idempotent: re-running skips wards that already carry `building_id`.
// ──────────────────────────────────────────────────────────────────────

import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const dryRun = process.argv.includes('--dry-run');
const project = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT;
if (!project) {
  console.error('Set GOOGLE_CLOUD_PROJECT (e.g. kindoo-staging or kindoo-prod) before running.');
  process.exit(1);
}

initializeApp({ credential: applicationDefault(), projectId: project });
const db = getFirestore();

let scanned = 0;
let alreadySet = 0;
let updated = 0;
let unmatched = 0;

const stakes = await db.collection('stakes').get();
for (const stake of stakes.docs) {
  const stakeId = stake.id;
  const [wards, buildings] = await Promise.all([
    db.collection(`stakes/${stakeId}/wards`).get(),
    db.collection(`stakes/${stakeId}/buildings`).get(),
  ]);

  // building_name → building_id, for this stake.
  const idByName = new Map();
  for (const b of buildings.docs) {
    const data = b.data();
    if (data.building_name) idByName.set(data.building_name, data.building_id ?? b.id);
  }

  for (const ward of wards.docs) {
    scanned += 1;
    const data = ward.data();
    if (data.building_id) {
      alreadySet += 1;
      continue;
    }
    const buildingId = idByName.get(data.building_name);
    if (!buildingId) {
      unmatched += 1;
      console.warn(
        `UNMATCHED  ${stakeId}/${ward.id}: building_name '${data.building_name}' has no building doc — fix the data, then re-run.`,
      );
      continue;
    }
    updated += 1;
    console.log(
      `${dryRun ? 'WOULD SET ' : 'SET       '} ${stakeId}/${ward.id}: building_id = '${buildingId}' (from building_name '${data.building_name}')`,
    );
    if (!dryRun) {
      await ward.ref.update({ building_id: buildingId });
    }
  }
}

console.log(
  `\n${dryRun ? '[dry-run] ' : ''}project=${project} wards scanned=${scanned} already-set=${alreadySet} ${dryRun ? 'would-update' : 'updated'}=${updated} unmatched=${unmatched}`,
);
if (unmatched > 0) {
  console.log(
    'Some wards reference a building_name with no building doc (see UNMATCHED lines above).',
  );
}
