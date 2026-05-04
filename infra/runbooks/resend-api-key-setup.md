# Resend API key setup (Phase 9)

Operator runbook for provisioning the Resend API key into Secret
Manager so Cloud Functions can send email through the verified
`mail.stakebuildingaccess.org` mail subdomain.

T-04 closed 2026-05-02 — the domain is already verified with Resend
(DKIM CNAME + DMARC TXT propagated). This runbook covers the API key
that the Cloud Functions runtime needs to authenticate as the verified
sender.

Run once per project (`kindoo-staging` first; repeat for `kindoo-prod`
at cutover).

## Prereqs

- `gcloud` CLI installed and authenticated.
- Operator has Secret Manager Admin on the target project.
- A Resend account with the `mail.stakebuildingaccess.org` domain
  showing **Verified** in the dashboard.

## Steps

### 1. Generate the API key in Resend

1. Sign in to https://resend.com → **API Keys** → **Create API Key**.
2. Name: `kindoo-staging functions` (use `kindoo-prod functions` for
   the prod key).
3. Permission: **Sending access** — _not_ Full access.
4. Domain: `mail.stakebuildingaccess.org`.
5. Copy the key. Resend shows it exactly once. Paste it somewhere
   short-lived (clipboard manager, sticky note that gets ripped up).

### 2. Stash the key in Secret Manager

> **Simplest path: skip steps 2 + 3 entirely.** Run `pnpm
> deploy:staging` and Firebase CLI auto-prompts for the secret value
> on the first deploy of a function declaring
> `secrets: ['RESEND_API_KEY']`. The CLI creates the
> `RESEND_API_KEY` secret in Secret Manager and grants the runtime SA
> `roles/secretmanager.secretAccessor` in one step. The gcloud
> commands below are the manual alternative for ops automation or
> when the prompt isn't an option (e.g., scripted bootstrap).

The secret name is `RESEND_API_KEY` (uppercase) — must match the
`secrets: ['RESEND_API_KEY']` declaration in
`functions/src/triggers/notifyOnRequestWrite.ts` /
`functions/src/triggers/notifyOnOverCap.ts`. Cloud Functions mounts
the secret as the `RESEND_API_KEY` env var at runtime.

```bash
# Replace <RESEND_API_KEY> with the value from step 1.
# `printf` (not `echo`) avoids a trailing newline that would
# corrupt the secret value.
printf '%s' "<RESEND_API_KEY>" | gcloud secrets create RESEND_API_KEY \
  --project=kindoo-staging \
  --replication-policy=automatic \
  --data-file=-
```

Verify the secret exists and is one version, no extra whitespace:

```bash
gcloud secrets versions list RESEND_API_KEY --project=kindoo-staging
gcloud secrets versions access latest --secret=RESEND_API_KEY \
  --project=kindoo-staging | wc -c
# Should print the exact byte length of the key (no newline).
```

### 3. Grant the runtime SA access to read the secret

The function runtime is `kindoo-app@<project>.iam.gserviceaccount.com`
(per `functions/src/lib/admin.ts` and `infra/CLAUDE.md`).

```bash
gcloud secrets add-iam-policy-binding RESEND_API_KEY \
  --project=kindoo-staging \
  --member=serviceAccount:kindoo-app@kindoo-staging.iam.gserviceaccount.com \
  --role=roles/secretmanager.secretAccessor
```

The triggers (`notifyOnRequestWrite`, `notifyOnOverCap`) declare
`secrets: [RESEND_API_KEY]` in their options block; Cloud Functions
mounts the secret as the `RESEND_API_KEY` env var at runtime.

### 4. Set `WEB_BASE_URL` on the functions deploy

The link builder in `functions/src/services/EmailService.ts` reads
`process.env.WEB_BASE_URL` to compose deep-link URLs in email bodies.
Declared via `defineString('WEB_BASE_URL')` in both notification
triggers — operator sets the value at deploy time.

(The runtime service-account email is mechanically derived from
`GCLOUD_PROJECT` in `functions/src/lib/admin.ts` —
`kindoo-app@${GCLOUD_PROJECT}.iam.gserviceaccount.com`. No env var
needed; Firebase CLI sets `GCLOUD_PROJECT` at deploy-analysis time and
at runtime.)

**Option A — `.env.<project>` file (recommended).** Cloud Functions
auto-injects values from `.env.<project>` at deploy time per the
[Firebase docs](https://firebase.google.com/docs/functions/config-env).

Maintain the file in `functions/` (the source-of-truth location):

```bash
# Create the file once per project. Stay out of git — these files
# are gitignored.
cat > functions/.env.kindoo-staging <<EOF
WEB_BASE_URL=https://stakebuildingaccess.org
EOF
```

For prod:

```bash
cat > functions/.env.kindoo-prod <<EOF
WEB_BASE_URL=https://stakebuildingaccess.org
EOF
```

**Where the build puts these files.** `firebase.json` sets
`source: functions/lib`, so Firebase CLI reads `.env.<project>` from
`functions/lib/`, _not_ `functions/`. The `functions/` build script
(`functions/scripts/build.mjs`) copies every `.env.*` from
`functions/` into `functions/lib/` after `tsc`/`esbuild` emit, so the
source-of-truth file flows into the deploy artifact automatically.
The copy is unconditional — source overwrites lib/ on every build.
This is intentional: a stale empty `lib/.env.<project>` from a prior
CLI prompt would otherwise silently shadow the real source value.

If you see "duplicate" `.env.<project>` files at both paths, that's
expected: `functions/.env.<project>` is the source you edit;
`functions/lib/.env.<project>` is the build-output copy Firebase CLI
reads. The next build will resync lib/ to match source.

**Option B — interactive prompt.** If no `.env.<project>` is present
in `functions/lib/`, `firebase deploy --only functions` will prompt
for the value and stash it in `functions/lib/.env.<project>`
automatically. **Important:** copy that value into the matching
`functions/.env.<project>` immediately so it survives the next build
(which always overwrites `lib/` from source). This is convenient for
the first deploy but easy to forget; prefer Option A.

### 5. Deploy and verify

```bash
bash infra/scripts/deploy-staging.sh --from-pr 44   # or whatever PR is current
```

Then in the Cloud Functions console (or `gcloud functions describe
notifyOnRequestWrite --region=us-central1 --project=kindoo-staging`):

- The function's **Secrets** section lists `RESEND_API_KEY`.
- The function's **Environment variables** section lists `WEB_BASE_URL`.

### 6. Smoke-test (post-deploy, manual)

In the staging app:

1. Submit a new request as a bishopric user → verify the new-request
   email arrives in the active manager's inbox.
2. Mark complete → verify the requester gets a completed email.
3. Reject → verify the rejected email surfaces `rejection_reason`.
4. Cancel a pending request → verify managers get a cancelled email.
5. Trigger an over-cap import (manually nudge a ward seat_cap below
   its current count, then run "Import Now") → verify the over-cap
   email arrives with the correct count/cap/over-by line.
6. Send to a known-bad address: change a manager's `member_email` to
   `bounce@simulator.amazonses.com` (or any bogus domain), submit a
   request → confirm the trigger does NOT crash AND a row with
   `action=email_send_failed` appears in the audit log.

### 7. Verify DKIM

Open one of the test emails in Gmail's web UI → click the three-dot
menu → **Show original**. Look for:

- `DKIM: PASS with domain mail.stakebuildingaccess.org`
- `DMARC: PASS`
- The sender line should NOT show `via …` (the legacy "via
  resend.dev" disclaimer that fires on un-verified domains).

## Rotation

When a key is rotated (lost, leaked, employee turnover):

```bash
# 1. Generate a fresh key in Resend, scoped the same way.
# 2. Add a new version to the existing secret.
printf '%s' "<NEW_KEY>" | gcloud secrets versions add RESEND_API_KEY \
  --project=kindoo-staging --data-file=-

# 3. Disable the old version after a redeploy verifies the new one
#    is live.
gcloud secrets versions disable <OLD_VERSION> --secret=RESEND_API_KEY \
  --project=kindoo-staging
```

Cloud Functions reads `latest` by default, so step 2 takes effect on
the next function cold start. No code change needed.

## Troubleshooting

- **Function logs show `RESEND_API_KEY is not set`** — the secret
  binding is missing. Verify (a) the secret exists, (b) the SA has
  `secretmanager.secretAccessor` on it, and (c) the trigger's options
  block declares `secrets: [RESEND_API_KEY]`. Redeploy.
- **Function logs show `WEB_BASE_URL is not set on the function`** —
  no `.env.<project>` value reached the deploy artifact. Check both
  `functions/.env.<project>` (source) AND `functions/lib/.env.<project>`
  (build output Firebase CLI actually reads). If `lib/` has an empty
  or missing value, delete `functions/lib/.env.<project>` and run
  `pnpm --filter @kindoo/functions build` to repopulate from source,
  then redeploy.
- **Emails go to spam in Gmail** — first send for a new sender domain
  often does. Mark one not-spam; subsequent sends train cleanly.
- **Resend dashboard shows the request "delivered" but no inbox
  delivery** — operator inbox-side filter; check Gmail's All Mail and
  the trash.
- **`email_send_failed` audit rows appearing on every send** — read
  one of the rows' `after.error_message` and `after.error_code`. A
  401/403 means the API key isn't accepted; a 422 with
  `domain_not_verified` means the verified-domain claim was revoked
  (re-verify in the Resend dashboard); a 429 means rate-limited (free
  tier is 100/day — unlikely at our scale).
