# Runbook: Observability — metrics, alerts, logs

What's monitored, where the data lives, what fires when, and how to add to it. Operator-readable; this runbook is the entry point when you see an alert or want to debug something.

> **STATUS (as of 2026-04-27):** Phase 1 skeleton. Most concrete content (metric names, alert numbers, console URLs) is **TODO until operator task B1** lands and creates the real Firebase projects in GCP.

## What's monitored

### Phase 1 (this phase)

- **Cloud Functions 5xx rate** — alert on > 1/min for 5min; routes to Tad's email.
- **Firestore rules-denied count** — log-based metric; useful baseline. No alert in Phase 1; review weekly during Phases 2–4.
- **Audit trigger failures** — log-based metric; activates when Phase 8 lands the trigger.
- **Claim sync failures** — log-based metric; activates when Phase 2 lands the triggers.

### Phase 4

- Auth verification failures > 5/hour. (Catches misconfigured client builds or attempted forgery.)

### Phase 8

- Importer didn't complete within 10min of scheduler fire.
- Expiry didn't complete within 5min of fire.

## Where to find data

> **TODO post-B1:** Drop the actual console URLs in here. Until then, generic templates.

| Concern | Where |
|---|---|
| Function logs (recent + searchable) | `https://console.cloud.google.com/logs/query?project=kindoo-prod` |
| Function execution metrics | `https://console.cloud.google.com/functions/list?project=kindoo-prod` |
| Firestore rules-denied requests | Cloud Logging with filter `resource.type="firestore.googleapis.com/Database" AND protoPayload.status.code=7` |
| Active alerts | `https://console.cloud.google.com/monitoring/alerting?project=kindoo-prod` |
| Notification channels | `https://console.cloud.google.com/monitoring/alerting/notifications?project=kindoo-prod` |
| GCS backup contents | `gsutil ls gs://kindoo-prod-backups/` |

For staging, replace `kindoo-prod` with `kindoo-staging` everywhere.

## What fires, what to do

### Alert: "Cloud Functions 5xx rate exceeded"

- **Means:** A Cloud Function has been returning 5xx > 1/min for 5min.
- **First step:** Open the alert in the Cloud Monitoring console; it links to the function and time range.
- **Inspect:** Function logs filtered to `severity>=ERROR` for the time range.
- **Common causes:**
  - Recently-deployed function has a bug. Check `git log --oneline functions/`.
  - Downstream dependency (Sheets API, Resend) returning errors. Check the function's specific error message.
  - Quota or rate-limit hit. Check the function's metrics.
- **If urgent:** Roll back the function deploy via `infra/runbooks/deploy.md` rollback section.
- **Auto-close:** 24h.

> **TODO Phase 4+:** Add response runbooks for each subsequent alert as it lands.

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

## Manual verification (post-B1)

> **TODO:** Once B1 lands and metrics + alerts are applied, walk this runbook. Verify each link resolves and each described path works. Per `infra/CLAUDE.md` invariant 5, runbooks must be testable.
