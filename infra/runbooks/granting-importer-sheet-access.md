# Runbook: Grant the importer service account Viewer on the LCR sheet

The weekly importer Cloud Function (`runImporter`) reads each stake's LCR
callings sheet via the function's runtime service account. Before the
first import can succeed, the operator (or stake bootstrap admin) must
share the LCR sheet with the function's service account at Viewer level.

This runbook is the per-stake bootstrap step. Repeat for each stake
during onboarding.

> **Audience:** the operator (Tad) or a stake bootstrap admin during
> Phase 7's wizard. This is documented as a standalone checklist so the
> bootstrap admin can complete it without an engineer pairing.
>
> **Estimated time:** ~3 minutes per sheet.

## Pre-flight

- The Firebase project must already be provisioned (see
  `infra/runbooks/provision-firebase-projects.md`).
- The Cloud Functions for that environment must already be deployed at
  least once — the runtime service account is created on the first
  deploy. Confirm by visiting
  <https://console.cloud.google.com/iam-admin/serviceaccounts> and
  filtering for `kindoo-app@<project>.iam.gserviceaccount.com`. If it's
  not there, run `pnpm deploy:staging` or `pnpm deploy:prod` first.
- The LCR sheet must be the URL the stake configured under
  `stakes/{stakeId}.callings_sheet_id` (the wizard's Step 1 captures
  this).

## Step 1 — Find the service account email

Each Firebase project has its own runtime SA. Run:

```bash
gcloud iam service-accounts list \
  --project=<PROJECT_ID> \
  --filter="email:kindoo-app@*"
```

Substitute `<PROJECT_ID>` with `kindoo-staging` or `kindoo-prod`. Expected
output is a single row with email
`kindoo-app@<PROJECT_ID>.iam.gserviceaccount.com`. Copy that email — you'll
paste it into the sheet's share dialog in Step 3.

If you can't run `gcloud`, the email is structurally the same as
`kindoo-app@<PROJECT_ID>.iam.gserviceaccount.com`; just substitute the
project ID.

## Step 2 — Open the LCR sheet

Open the LCR-exported callings sheet for the stake (the URL the stake
admin pasted into the wizard). Confirm it's the right one by checking
that:

- The tab list includes **Stake** plus a tab per ward (e.g. **CO**,
  **BR**), and
- Each tab's **Position**, **Name**, and **Personal Email** columns are
  populated for the rows you expect.

## Step 3 — Share the sheet with the service account

In the LCR sheet:

1. Click **Share** (top right).
2. Paste the service-account email from Step 1 into the "Add people and
   groups" box.
3. Set the access level to **Viewer**. (The importer never writes —
   Viewer is the minimum needed.)
4. **Uncheck** "Notify people" — service accounts can't read email.
5. Click **Share** (or **Done**).

The dialog may flag the address as not a Google account; this is normal
for service accounts. Confirm anyway.

## Step 4 — Verify the share

Run a manual import via the manager UI's "Import Now" button on the
Configuration page. Expected outcome:

- The import completes (`ok: true`) and the stake's `last_import_summary`
  reflects insert/delete counts.
- The audit log shows an `import_start` and `import_end` row pair.

If the import fails with a `404 Not Found` or `403 Forbidden`, the share
didn't take. Re-check the email spelling in the share dialog (a
character can be lost on copy-paste) and re-share.

## Rotating the service account

If the runtime SA is ever rotated (e.g., destructive `firebase functions:
config:unset` followed by re-deploy mints a fresh SA), the old SA's
sharing entry on the sheet still works — Google preserves the row even
if the SA is deleted, and it doesn't grant access. Re-run Steps 1-3 with
the new SA email; remove the stale row from the sheet's share dialog at
your leisure.

## Multi-stake (Phase B)

When a second stake is provisioned, they get their own LCR sheet but the
same service account in the same Firebase project. So the stake's
bootstrap admin runs Steps 2-4 against their sheet only; the SA email is
unchanged.
