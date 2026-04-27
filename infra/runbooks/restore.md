# Runbook: Restoring Firestore data

Three restore strategies, each appropriate for different incident shapes. **All three are TODO until operator task B1 lands** — until real Firebase projects exist with Firestore Native databases, there's nothing to restore from.

> **STATUS (as of 2026-04-27):** Phase 1 skeleton. Full content lands once B1 enables PITR and the weekly export job is configured.

## When to use which

| Strategy | Window | Cost | Use when |
|---|---|---|---|
| **PITR** (point-in-time recovery) | Last 7 days | Free with PITR enabled | A bad write was made in the last week and you want to roll the whole database back to a moment before it. |
| **Full GCS-export restore** | Last 90 days (weekly snapshots) | Storage cost only | PITR window has passed; you have a full weekly snapshot from before the incident. |
| **Partial collection restore** | Same windows as above | Engineer time + storage | You only need to restore one collection (e.g., `seats`) without rolling back everything else. |

## PITR restore (within last 7 days)

PITR lets you read the database as of any second within the last 7 days, then export that snapshot to a new database. Steps:

> **TODO post-B1:**
> 1. Enable PITR on `kindoo-prod` if not already (`gcloud firestore databases update --database='(default)' --enable-pitr --project=kindoo-prod`).
> 2. Identify the timestamp to restore to (in RFC3339 UTC).
> 3. Export at that timestamp to a GCS bucket.
> 4. Import the export into a fresh database OR replace the live database.
>
> Document the exact `gcloud firestore export` and `import` invocations once tested in staging.

## Full GCS-export restore (last 90 days)

The weekly export job (Sunday 02:00) writes a full database snapshot to `gs://kindoo-prod-backups/YYYY-MM-DD/`. The bucket has a 90-day lifecycle rule so the most recent ~12 snapshots are always available.

> **TODO post-B1:**
> 1. List available snapshots: `gsutil ls gs://kindoo-prod-backups/`.
> 2. Choose the snapshot date.
> 3. Run `gcloud firestore import gs://kindoo-prod-backups/<date>/ --project=kindoo-prod`.
> 4. **WARNING:** This **overwrites** the existing database. Operator confirmation required; see the "Pre-flight" section once written.

## Partial collection restore

When only one collection is corrupt and you don't want to roll back the rest of the database.

> **TODO post-B1:**
> 1. Restore the snapshot to a **separate** project (`kindoo-restore-staging` or similar).
> 2. Read the desired collection from the restored project.
> 3. Write to the live project under a new collection name (e.g., `seats_restored`).
> 4. Once verified, swap by renaming or merging.
>
> This is the most operationally complex of the three; expect to spend 2-4 hours on the actual mechanics.

## Manual verification (post-B1)

> **TODO:** Once B1 lands, rehearse each of the three restore paths against `kindoo-staging`. Restore drills are a Phase 11 acceptance-criteria item; they prove the runbook is testable per `infra/CLAUDE.md` invariant 5.
