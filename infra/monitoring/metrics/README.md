# infra/monitoring/metrics/

Log-based metric definitions for Cloud Monitoring. Each `*.yaml` file describes a single log-based metric: a Cloud Logging filter, a metric kind (counter, distribution), and any value extractor. Metrics are applied via the `gcloud logging metrics create` command (see each file's header for the exact invocation).

## What's here, when

| File | Phase | What it counts |
|---|---|---|
| `audit-trigger-failures.yaml` | 1 | Cloud Function exceptions on the audit fan-in trigger. Activated by an alert on count > 0. |
| `claim-sync-failures.yaml` | 1 | Cloud Function exceptions on `syncAccessClaims`, `syncManagersClaims`, `syncSuperadminClaims`. |
| `firestore-rules-denied-count.yaml` | 1 | Firestore rules-denied requests visible in Cloud Logging. High-water mark for misconfigured client queries or attempted privilege escalation. |
| `importer-duration.yaml` | 8 | Duration distribution for the importer's hourly run. Drives the "importer didn't complete in 10 min" alert. |
| `expiry-duration.yaml` | 8 | Duration distribution for the temp-seat expiry's hourly run. |

(Phase 8 metrics aren't created in Phase 1 — listed here as a forward reference only. Backend-engineer adds them when Phase 8 lands.)

## How to apply

These metrics are applied to **both** `kindoo-staging` and `kindoo-prod` once B1 lands. Sample command (see each YAML's header for the actual filter):

```bash
gcloud logging metrics create audit-trigger-failures \
  --project=kindoo-prod \
  --description="Audit fan-in trigger failures" \
  --log-filter='resource.type="cloud_function" AND textPayload:"auditTrigger" AND severity>=ERROR'
```

Apply to staging too — same command, `--project=kindoo-staging`. The runbook at `infra/runbooks/observability.md` walks the operator through.

## How to add a new metric

1. Create `<metric-name>.yaml` here with the filter and gcloud command.
2. Run the gcloud command in both projects.
3. If the metric drives an alert, add the alert YAML in `../alerts/`.
4. Update `infra/runbooks/observability.md` so operators know what fires when.

## Until B1 lands

These YAML files are **reference-only**. The gcloud commands won't execute against a real project until B1 creates `kindoo-staging` and `kindoo-prod`. The filter strings + structure are settled now so Phase 1 review is meaningful.
