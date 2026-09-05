# Runbook: Observability — metrics, alerts, logs

What is monitored, where the data lives, what fires when, and how to add to it. Operator-readable; this runbook is the entry point when you see an alert or want to debug something.

## What is monitored

### Currently wired

- **Cloud Functions 5xx rate** — alert on > 1/min sustained for 5min; routes to Tad's email. Defined in `infra/monitoring/alerts/5xx-rate.yaml`.
- **Firestore rules-denied count** — log-based metric; baseline visibility, no alert. Defined in `infra/monitoring/metrics/firestore-rules-denied-count.yaml`.
- **Audit trigger failures** — log-based metric on errors from the nine `audit*Writes` fan-in triggers. Mostly transient now that those triggers retry, so read it as a health signal. Defined in `infra/monitoring/metrics/audit-trigger-failures.yaml`.
- **Audit rows dropped** — log-based metric on audit rows the trigger permanently rejected. Unlike the metric above, every hit is real data loss. Defined in `infra/monitoring/metrics/audit-row-dropped.yaml`.
- **Claim sync failures** — log-based metric on `syncAccessClaims`, `syncManagersClaims`, `syncSuperadminClaims` exceptions. Defined in `infra/monitoring/metrics/claim-sync-failures.yaml`.
- **Scheduled-task failures** — log-based metric on errors from `dispatchScheduledTasks` and `runScheduledTask` (T-104). Catches a dispatcher that runs and fails; **cannot** catch one that stops running. Defined in `infra/monitoring/metrics/scheduled-task-failures.yaml`. Read "Scheduled-task dispatch" below before trusting a zero.

### Not yet wired

These were sketched in the migration plan but the alert/metric YAML files do not exist yet. Add them when the operational need is concrete.

- Auth verification failures > 5/hour. Catches misconfigured client builds or attempted forgery.
- **Alert on `audit-row-dropped` > 0.** The metric exists; no alert routes off it yet. Any non-zero value means an audit row was thrown away and cannot be reconstructed, and since T-102 removed the reconciliation sweep nothing else will ever surface it. Highest-value alert on this list.
- **Absence alert on `dispatchScheduledTasks` invocations.** Nothing detects a dispatcher that simply stopped. See "Scheduled-task dispatch" below for why no counter can, and for the condition shape that would.

## Where to find data

| Concern | Where |
|---|---|
| Function logs (recent + searchable) | `https://console.cloud.google.com/logs/query?project=kindoo-prod` |
| Function execution metrics | `https://console.cloud.google.com/functions/list?project=kindoo-prod` |
| Firestore rules-denied requests | Cloud Logging with filter `resource.type="firestore.googleapis.com/Database" AND protoPayload.status.code=7` |
| Cloud Scheduler jobs (3/3 free tier: dispatcher ×2 projects + prod weekly export) | `https://console.cloud.google.com/cloudscheduler?project=kindoo-prod` |
| Cloud Tasks queue for `runScheduledTask` | `https://console.cloud.google.com/cloudtasks?project=kindoo-prod` |
| Active alerts | `https://console.cloud.google.com/monitoring/alerting?project=kindoo-prod` |
| Notification channels | `https://console.cloud.google.com/monitoring/alerting/notifications?project=kindoo-prod` |
| GCS backup contents | `gcloud storage ls gs://kindoo-prod-backups/` |

For staging, replace `kindoo-prod` with `kindoo-staging` everywhere.

## What fires, what to do

### Alert: "Cloud Functions 5xx rate exceeded"

- **Means:** A Cloud Function has been returning 5xx > 1/min for 5min.
- **First step:** Open the alert in the Cloud Monitoring console; it links to the function and time range.
- **Inspect:** Function logs filtered to `severity>=ERROR` for the time range.
- **Common causes:**
  - Recently-deployed function has a bug. Check `git log --oneline functions/`.
  - Downstream dependency returning errors. Functions call out to Firestore (data layer), Resend (email vendor, per F16), FCM (push), and Secret Manager (`RESEND_API_KEY`). Cloud Run is the v2 functions runtime (not a downstream). Check the function's specific error message.
  - Quota or rate-limit hit. Check the function's metrics.
- **If urgent:** Roll back the function deploy via `infra/runbooks/deploy.md` rollback section.
- **Auto-close:** 24h.

### Scheduled-task dispatch (T-104)

**Why this section is longer than its alert coverage deserves: there is no alert.** Every scheduled feature in this stack reaches its handler through one hourly function, `dispatchScheduledTasks`, and one runner, `runScheduledTask`. That is deliberate — it is what keeps the whole system inside Cloud Scheduler's 3-job free tier — but it also means a single silent failure stops *all* scheduled work at once, with no user-visible symptom beyond something not happening. Nobody gets paged. Somebody has to look.

**The three failure shapes, in descending order of how likely they are to go unnoticed.**

**(1) The dispatcher stopped running.** The Cloud Scheduler job was paused, deleted, or never created by a deploy. The dispatcher logs nothing, because it never executes — so `scheduled-task-failures` reads zero, `5xx-rate` reads zero, and every dashboard looks healthy. **No log-based counter can ever detect this**, because there is no log entry to count. This is the failure mode to be afraid of.

Check it directly:

```bash
gcloud scheduler jobs list --project=kindoo-prod --location=us-central1 \
  --format="value(name,state,schedule)"
gcloud logging read \
  'resource.type="cloud_run_revision" AND resource.labels.service_name="dispatchscheduledtasks"' \
  --project=kindoo-prod --limit=5 --freshness=3h \
  --format="value(timestamp,severity)"
```

Expected: a row `ENABLED	0 * * * *` whose name ends `dispatchScheduledTasks-us-central1`, and at least two log entries in the last three hours. Zero entries against an `ENABLED` job means the job is firing and the function is failing to start — go to (2). No such job at all means a deploy never created it, or something deleted it; re-deploy and walk `infra/runbooks/deploy.md`, "First deploy after T-104."

*What would close this gap:* a Cloud Monitoring alert policy using a **metric-absence** condition (not a threshold) on `run.googleapis.com/request_count` filtered to `service_name="dispatchscheduledtasks"`, with a duration comfortably over one hour — say 3h, so a single missed tick or a slow scheduler doesn't page. It is the only condition type that fires on nothing happening. No YAML exists for it; add it under `infra/monitoring/alerts/` when the operational need is concrete.

**(2) The dispatcher runs and throws.** Counted by `scheduled-task-failures`. Logs land under `dispatchscheduledtasks`.

```bash
gcloud logging read \
  'resource.type="cloud_run_revision" AND resource.labels.service_name="dispatchscheduledtasks" AND severity>=ERROR' \
  --project=kindoo-prod --limit=20 --freshness=24h \
  --format="value(timestamp,jsonPayload.message)"
```

The likeliest cause on a newly-deployed project is **not a bug — it is missing IAM**. `firebase deploy` creates the Cloud Tasks queue but does not grant permission to enqueue onto it, so the dispatcher walks the stakes correctly and then fails on every enqueue with a `PERMISSION_DENIED` naming `cloudtasks.tasks.create` or `iam.serviceAccounts.actAs`. Fix: `infra/runbooks/deploy.md`, "First deploy after T-104," step 3. There are exactly two bindings and both are operator-granted.

**(3) A job handler throws inside the runner.** Logs land under `runscheduledtask`, also counted by `scheduled-task-failures`. Cloud Tasks retries a failed task, so a single error is usually self-healing and this reads as a rate signal, not a loss signal — the same posture as `audit-trigger-failures`. A handler erroring on every retry until the queue gives up *is* lost work, and nothing reconciles it — re-run the affected stake's job by hand once the cause is fixed. Drop `severity>=ERROR` and widen `--freshness` to see the surrounding entries; which stake and which job a failure belongs to is whatever the handler logged.

**Service names are lowercase in every filter above.** Cloud Run service names are RFC1123, so `dispatchScheduledTasks` logs under `dispatchscheduledtasks`. A filter written with the camelCase export name matches nothing and is indistinguishable from "it never ran" — which is exactly failure (1), so getting this wrong manufactures the scariest symptom out of a typo.

**Scope note.** This covers the dispatch plumbing, not what any individual job does. A trigger that is disabled, or whose `next_trigger_time` is wrong, is a data question — read that stake's `stakeSchedules/{stakeId}` document — not a monitoring one.

## How to add a new metric

1. Define the metric YAML at `infra/monitoring/metrics/<name>.yaml`. See existing files for format.
2. Apply to both projects:
   ```bash
   gcloud logging metrics create <name> \
     --project=kindoo-prod \
     --description="..." \
     --log-filter='...'
   gcloud logging metrics create <name> \
     --project=kindoo-staging \
     --description="..." \
     --log-filter='...'
   ```
3. If the metric should drive an alert, add the alert YAML at `infra/monitoring/alerts/<name>.yaml` and apply it (see `monitoring/alerts/README.md`).
4. Update this runbook with the alert response.

## How to add a new alert

1. Define the alert YAML at `infra/monitoring/alerts/<name>.yaml`. See `5xx-rate.yaml` for format.
2. Substitute the actual notification channel resource name.
3. Apply to both projects:
   ```bash
   gcloud alpha monitoring policies create \
     --project=kindoo-prod \
     --policy-from-file=infra/monitoring/alerts/<name>.yaml
   gcloud alpha monitoring policies create \
     --project=kindoo-staging \
     --policy-from-file=infra/monitoring/alerts/<name>.yaml
   ```
4. Test by deliberately triggering the condition in staging (where appropriate).
5. Document the response in this runbook's "What fires, what to do" section.

## Manual verification

Once a quarter (or after any change to the alert/metric YAML in this directory), walk this runbook against `kindoo-prod`:

1. Open each link in the "Where to find data" table and confirm it loads.
2. Confirm each currently-wired metric appears under Cloud Logging → Logs-based Metrics.
3. Confirm each currently-wired alert appears under Cloud Monitoring → Alerting with `kindoo-prod` selected.
4. Confirm the notification channel for the 5xx alert still points at Tad's email.
5. Run the two commands under "Scheduled-task dispatch" step (1) against **both** projects. Nothing alerts on this, so the quarterly walk is the only thing that catches a dispatcher that quietly stopped. Expected: `kindoo-staging` one scheduler job, `kindoo-prod` two, and recent `dispatchscheduledtasks` log entries on each.

Per `infra/CLAUDE.md` invariant 5, runbooks must be testable; this is the check.
