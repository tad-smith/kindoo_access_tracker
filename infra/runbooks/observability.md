# Runbook: Observability — metrics, alerts, logs

What is monitored, where the data lives, what fires when, and how to add to it. Operator-readable; this runbook is the entry point when you see an alert or want to debug something.

## What is monitored

### Currently wired

- **Cloud Functions 5xx rate** — alert on > 1/min sustained for 5min; routes to Tad's email. Defined in `infra/monitoring/alerts/5xx-rate.yaml`.
- **Firestore rules-denied count** — log-based metric; baseline visibility, no alert. Defined in `infra/monitoring/metrics/firestore-rules-denied-count.yaml`.
- **Audit trigger failures** — log-based metric on `auditTrigger` Cloud Function exceptions. Defined in `infra/monitoring/metrics/audit-trigger-failures.yaml`.
- **Claim sync failures** — log-based metric on `syncAccessClaims`, `syncManagersClaims`, `syncSuperadminClaims` exceptions. Defined in `infra/monitoring/metrics/claim-sync-failures.yaml`.

### Not yet wired

These were sketched in the migration plan but the alert/metric YAML files do not exist yet. Add them when the operational need is concrete.

- Auth verification failures > 5/hour. Catches misconfigured client builds or attempted forgery.
- Importer did not complete within 10 minutes of scheduler fire.
- Expiry did not complete within 5 minutes of scheduler fire.

## Where to find data

| Concern | Where |
|---|---|
| Function logs (recent + searchable) | `https://console.cloud.google.com/logs/query?project=kindoo-prod` |
| Function execution metrics | `https://console.cloud.google.com/functions/list?project=kindoo-prod` |
| Firestore rules-denied requests | Cloud Logging with filter `resource.type="firestore.googleapis.com/Database" AND protoPayload.status.code=7` |
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
  - Downstream dependency (Sheets API, Resend) returning errors. Check the function's specific error message.
  - Quota or rate-limit hit. Check the function's metrics.
- **If urgent:** Roll back the function deploy via `infra/runbooks/deploy.md` rollback section.
- **Auto-close:** 24h.

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

Per `infra/CLAUDE.md` invariant 5, runbooks must be testable; this is the check.
