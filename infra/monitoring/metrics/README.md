# infra/monitoring/metrics/

Log-based metric definitions for Cloud Monitoring. Each `*.yaml` file describes a single log-based metric: a Cloud Logging filter, a metric kind (counter, distribution), and any value extractor. Metrics are applied via the `gcloud logging metrics create` command (see each file's header for the exact invocation).

## What's here, when

| File | Phase | What it counts |
|---|---|---|
| `audit-trigger-failures.yaml` | 1 | Errors on the nine `audit*Writes` fan-in triggers. Mostly transient since T-102 gave them `retry: true`; a health signal, not a loss signal. |
| `audit-row-dropped.yaml` | — | Audit rows permanently rejected and thrown away. The only detection path for lost audit rows. Wants an alert on count > 0. |
| `claim-sync-failures.yaml` | 1 | Cloud Function exceptions on `syncAccessClaims`, `syncManagersClaims`, `syncSuperadminClaims`. |
| `firestore-rules-denied-count.yaml` | 1 | Firestore rules-denied requests visible in Cloud Logging. High-water mark for misconfigured client queries or attempted privilege escalation. |

## How to apply

These metrics are applied to **both** `kindoo-staging` and `kindoo-prod` once B1 lands. Each YAML's header carries the exact command, as a loop over both projects; copy that rather than adapting the shape below.

```bash
for PROJECT in kindoo-staging kindoo-prod; do
  gcloud logging metrics create <metric-name> \
    --project="$PROJECT" \
    --description="..." \
    --log-filter='<the filter: body from the YAML, verbatim>'
done
```

**Get the resource type right.** Our Cloud Functions are all 2nd gen, so they run on Cloud Run and log under `resource.type="cloud_run_revision"` with the function identified by `resource.labels.service_name` — **lowercased**, because Cloud Run service names are RFC1123 (`auditAccessWrites` → `auditaccesswrites`). A filter written against 1st-gen `resource.type="cloud_function"` / `resource.labels.function_name` is accepted by gcloud, creates cleanly, and then counts zero forever. That is the failure mode T-102 found in this very file.

The runbook at `infra/runbooks/observability.md` walks the operator through.

## How to add a new metric

1. Create `<metric-name>.yaml` here with the filter and gcloud command.
2. Run the gcloud command in both projects.
3. If the metric drives an alert, add the alert YAML in `../alerts/`.
4. Update `infra/runbooks/observability.md` so operators know what fires when.

## Until B1 lands

These YAML files are **reference-only**. The gcloud commands won't execute against a real project until B1 creates `kindoo-staging` and `kindoo-prod`. The filter strings + structure are settled now so Phase 1 review is meaningful.
