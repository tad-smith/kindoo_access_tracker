# Runbook: Backfill `kindoo_site_id` on every seat (T-42)

Operator playbook for invoking the `backfillKindooSiteId` callable against `kindoo-staging` and `kindoo-prod`. One-shot migration — run once per project, verify counters, done. The callable is idempotent (skip-if-equal); re-runs over an already-migrated stake produce zero writes and zero audit rows.

The driver script lives at `infra/scripts/run-backfill-kindoo-site-id.mjs`. It signs in as an existing Kindoo Manager via the Admin SDK's custom-token flow (the operator authenticates the SPA via Google OAuth and has no email/password credential to use directly).

## What the backfill does

For every seat in `stakes/{stakeId}/seats`:

- Derives the primary `kindoo_site_id` from the seat's `scope` (`stake` → home; ward code → that ward's `kindoo_site_id`).
- Derives each `duplicate_grants[].kindoo_site_id` analogously.
- Rebuilds the primitive `duplicate_scopes` mirror so it matches `duplicate_grants[].scope`.
- Writes only seats whose derived values differ from what is already stored.

Audit rows land under `action='migration_backfill_kindoo_site_id'`. First run on a fresh stake produces one row per dirty seat (typically ~500–750 on csnorth); re-runs produce zero rows.

See `functions/src/callable/backfillKindooSiteId.ts` for the full callable contract.

## Prerequisites

1. **`gcloud auth application-default login`** as a user holding `roles/firebaseauth.admin` on the target project (`kindoo-staging` and/or `kindoo-prod`). The Admin SDK needs ADC to mint the custom token.

   ```bash
   gcloud auth application-default login
   gcloud auth application-default print-access-token  # should print a token
   ```

2. **`apps/web/.env.staging` and `apps/web/.env.production` populated.** The script reads these for the Firebase web SDK config (apiKey, projectId, appId, etc.). Both files are gitignored; see `apps/web/.env.example` for the schema and `infra/runbooks/provision-firebase-projects.md` for where the values come from.

3. **`pnpm install` at the repo root** so `infra/`'s `firebase-admin` + `firebase` deps are resolvable.

4. **An active Kindoo Manager of the target stake.** The callable's authority check reads `stakes/{stakeId}/kindooManagers/{canonicalEmail}` and requires `active: true`. The bootstrap admin `admin@csnorth.org` qualifies on `csnorth`.

5. **The callable is deployed.** Verify with `firebase functions:list --project kindoo-staging` (or `kindoo-prod`); `backfillKindooSiteId` should appear in the list.

## Run on staging

Always run staging first.

```bash
node infra/scripts/run-backfill-kindoo-site-id.mjs \
  --project kindoo-staging \
  --stake csnorth \
  --as admin@csnorth.org
```

Expected output (counters will vary):

```
Backfill complete for stake 'csnorth' on project 'kindoo-staging':
  Seats total:                           247
  Seats updated:                         247
  Primary kindoo_site_id skipped:          0  (missing ward)
  Duplicate grants updated:               18
  Duplicate grants skipped:                0  (missing ward)
  Duration:                              842ms
```

**Sanity-check.** `Seats total` should match the current seat count for the stake (open the Configuration page or run `firebase firestore:read 'stakes/csnorth/seats' --project kindoo-staging | wc -l`). `Seats updated` on the first run should be roughly equal to `Seats total`. Any `... skipped (missing ward)` count > 0 is a latent data bug: a seat or duplicate grant references a ward that no longer exists. The warnings list will name the seat docs — file a follow-up for the manager to clean those up; the migration itself leaves them untouched and downstream code handles the missing ward at read time.

**Re-run to prove idempotency.**

```bash
node infra/scripts/run-backfill-kindoo-site-id.mjs \
  --project kindoo-staging \
  --stake csnorth \
  --as admin@csnorth.org
```

Expected: `Seats updated: 0`, `Duplicate grants updated: 0`, and no new audit rows in `stakes/csnorth/auditLog` for the run window.

## Run on prod

Only after staging counters look right.

```bash
node infra/scripts/run-backfill-kindoo-site-id.mjs \
  --project kindoo-prod \
  --stake csnorth \
  --as admin@csnorth.org
```

Same sanity checks as staging. Re-run to confirm idempotency.

## Troubleshooting

- **`Could not look up '<email>' in <project>`** — the operator's email isn't in Firebase Auth for that project, or ADC lacks `roles/firebaseauth.admin`. Confirm the operator has signed in to the SPA at least once on that project, then re-check `gcloud auth application-default login` succeeded as the right human account.

- **`caller is not a manager of this stake`** — the canonicalised `--as` email has no `stakes/{stakeId}/kindooManagers/{canonicalEmail}` doc. The migration is a manager-only operation; the bootstrap admin is added during initial provisioning. Add the email as a manager via the SPA's Manager Management page first.

- **`manager record is inactive`** — same doc exists but `active: false`. Flip it active in the SPA, retry.

- **`Missing apps/web/.env.<mode>`** — populate from `apps/web/.env.example` with the values from Firebase console → Project settings → General → Your apps → Web → Config.

- **`VITE_FIREBASE_PROJECT_ID='X', expected 'Y'`** — the env file's `VITE_FIREBASE_PROJECT_ID` doesn't match `--project`. Either you have the wrong env file checked into your worktree, or `--project` is wrong.

- **Callable not found / 404** — `backfillKindooSiteId` isn't deployed. Run `pnpm deploy:staging` (or `:prod`) to deploy functions, then retry.

- **ADC project mismatch** — if ADC defaults to a different project, the Admin SDK still works because the script pins `projectId` explicitly via `initializeApp({ projectId })`. But if you see a project-mismatch error from the Admin SDK, set `GOOGLE_CLOUD_PROJECT=<kindoo-staging|kindoo-prod>` in the shell and retry.

## After running prod

- File the run in `docs/changelog/` if it was the production cutover for T-42 — counters in the changelog give future operators a baseline for "what's a sane seat count for csnorth."
- Mark T-42 closed in `docs/TASKS.md`.
- The follow-on importer cycle will preserve all backfilled values (its own write logic is skip-if-equal on the same fields).
