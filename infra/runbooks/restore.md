# Runbook: Restoring Firestore data

Three restore strategies, each appropriate for different incident shapes. PITR is enabled on `kindoo-prod` and a weekly Firestore export writes to `gs://kindoo-prod-backups/` with a 90-day lifecycle (per `infra/runbooks/provision-firebase-projects.md` Phase 3).

## When to use which

| Strategy | Window | Cost | Use when |
|---|---|---|---|
| **PITR** (point-in-time recovery) | Last 7 days | Negligible (PITR journal is well under $0.01/month at our scale) | A bad write was made in the last week and you want to roll the whole database back to a moment before it. |
| **Full GCS-export restore** | Last 90 days (weekly snapshots) | Storage cost only | PITR window has passed; you have a full weekly snapshot from before the incident. |
| **Partial collection restore** | Same windows as above | Engineer time + storage | You only need to restore one collection (e.g., `seats`) without rolling back everything else. |

## PITR restore (within last 7 days)

PITR lets you read the database as of any second within the last 7 days, then export that snapshot. Sequence:

1. **Confirm PITR is enabled.**
   ```bash
   gcloud firestore databases describe \
     --database='(default)' \
     --project=kindoo-prod \
     --format='value(pointInTimeRecoveryEnablement)'
   ```
   Expected: `POINT_IN_TIME_RECOVERY_ENABLED`. If anything else, PITR is off and this path is unavailable — fall through to the GCS-export restore.

2. **Identify the restore timestamp** in RFC3339 UTC, e.g. `2026-05-02T14:00:00Z`. Must be within the last 7 days and at least a few minutes in the past (PITR has a small lag).

3. **Export the PITR snapshot to GCS.**
   ```bash
   gcloud firestore export gs://kindoo-prod-backups/pitr-<incident-tag>/ \
     --database='(default)' \
     --snapshot-time=2026-05-02T14:00:00Z \
     --project=kindoo-prod
   ```
   The command returns an operation ID; watch progress with `gcloud firestore operations list --project=kindoo-prod`.

4. **Decide: restore in place, or restore to a separate database?**

   - **In place (overwrites live data):** `gcloud firestore import gs://kindoo-prod-backups/pitr-<incident-tag>/<operation-subdir>/ --project=kindoo-prod`. **WARNING:** this overwrites the live `(default)` database. Operator confirmation required; consider freezing writes (disable triggers + Cloud Scheduler) before importing.
   - **Side-by-side (recommended for partial-restore):** create a secondary database via `gcloud firestore databases create --database=restore-<incident-tag> ...`, import there, then read the affected collection(s) and replay writes against `(default)`. Slower but reversible.

5. **Re-enable any writes you froze**, and verify the restored data via the SPA or `gcloud firestore` queries.

## Full GCS-export restore (last 90 days)

The weekly Cloud Scheduler export job (Sunday 02:00 UTC) writes a full snapshot to `gs://kindoo-prod-backups/<operation-timestamp>/`. The bucket has a 90-day lifecycle rule, so the most recent ~12 snapshots are always available.

1. **List available snapshots.**
   ```bash
   gcloud storage ls gs://kindoo-prod-backups/
   ```
   Expected: a series of subdirectories like `gs://kindoo-prod-backups/2026-05-03T02:00:13_98765/`. Pick the one immediately before the incident.

2. **Import the snapshot.**
   ```bash
   gcloud firestore import gs://kindoo-prod-backups/<chosen-subdir>/ \
     --project=kindoo-prod
   ```
   **WARNING:** This overwrites the existing `(default)` database. Operator confirmation required. As with PITR-in-place, consider freezing Cloud Scheduler jobs and the Cloud Functions notification triggers before importing to avoid double-fire on the imported state.

3. **Verify** by signing in to the SPA and spot-checking representative documents.

## Partial collection restore

When only one collection is corrupt and you do not want to roll back the rest of the database.

1. **Create a side-by-side restore database** (do not overwrite live).
   ```bash
   gcloud firestore databases create \
     --database=restore-<incident-tag> \
     --location=<same-region-as-default> \
     --project=kindoo-prod
   ```

2. **Import the chosen snapshot into the restore database.**
   ```bash
   gcloud firestore import gs://kindoo-prod-backups/<chosen-subdir>/ \
     --database=restore-<incident-tag> \
     --project=kindoo-prod
   ```

3. **Read the affected collection from the restore database** and write it back to `(default)`. A short Node script using the Admin SDK pointed at two databases is the simplest path — `getFirestore(app, 'restore-<incident-tag>')` for reads, `getFirestore(app)` for writes. Write under the original collection name (overwrite) or a sibling name (e.g. `seats_restored`) if you want operator review before the swap.

4. **Once verified, delete the restore database** to avoid lingering cost:
   ```bash
   gcloud firestore databases delete --database=restore-<incident-tag> --project=kindoo-prod
   ```

This is the most operationally complex of the three; expect to spend 2–4 hours on the actual mechanics.

## Manual verification

Rehearsal cadence: at least once a year, walk one of the three paths against `kindoo-staging` end-to-end and confirm the data lands where expected. The actual production restore drill was performed before Phase 11 cutover; record subsequent rehearsals in `docs/changelog/`.

Per `infra/CLAUDE.md` invariant 5, runbooks must be testable; the rehearsal is the test.
