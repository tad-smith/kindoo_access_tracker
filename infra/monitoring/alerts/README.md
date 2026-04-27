# infra/monitoring/alerts/

Cloud Monitoring alert policy definitions. Each `*.yaml` describes a single alert: which metric (or log filter) to watch, the threshold, the duration, and the notification channel(s).

## Notification channel

For Phase 1 every alert routes to **a single notification channel: Tad's email**. The channel itself is provisioned manually in the Cloud Monitoring console (or via `gcloud alpha monitoring channels create`) once B1 lands. The channel's full resource name (e.g. `projects/kindoo-prod/notificationChannels/12345`) is referenced in each alert YAML.

When the team grows, additional channels (Slack, PagerDuty) get added here and referenced from the alerts.

## What's here, when

| File | Phase | What fires |
|---|---|---|
| `5xx-rate.yaml` | 1 | Any Cloud Function 5xx > 1/minute sustained for 5 minutes. Catches regressions in the rare HTTPS callable / Functions exception cases. |
| `auth-verification-failures.yaml` | 4 | Auth verification failures > 5/hour. Phase 4 onward. (Not in this directory yet.) |
| `importer-not-completed.yaml` | 8 | Importer didn't complete within 10 minutes of scheduler fire. (Not in this directory yet.) |
| `expiry-not-completed.yaml` | 8 | Expiry didn't complete within 5 minutes of fire. (Not in this directory yet.) |

(Phase 4+ alerts aren't created in Phase 1 — listed here as a forward reference.)

## How to apply

Once B1 lands and the notification channel exists:

```bash
gcloud alpha monitoring policies create \
  --project=kindoo-prod \
  --policy-from-file=infra/monitoring/alerts/5xx-rate.yaml
```

Apply to staging too — same command, `--project=kindoo-staging`.

## Until B1 lands

Same as `metrics/`: these YAMLs are reference-only. The `gcloud` commands won't execute against a real project until B1 creates `kindoo-staging` and `kindoo-prod`.
