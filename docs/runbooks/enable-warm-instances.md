# Enable warm instances on Cloud Run

**When to invoke:** Sunday users are consistently reporting >5-second loads on first access, and measurement confirms cold starts are the cause (check Cloud Run logs for `startup_latency` on instance start events). This runbook reverses the F13 decision — per the migration doc, F13 accepted cold starts as a trade-off for simplicity.

**What it does:** Schedules `min-instances=1` on the Cloud Run service for a defined warm window (e.g. Sunday 6:30 AM – 10:00 PM MT). Outside the window, the service scales to zero as before.

## Prerequisites

- GCP Owner or Editor on `kindoo-prod`.
- Cloud Run service deployed with `--cpu-throttling=false` (equivalent to "CPU always allocated") — required when `min-instances > 0`. If the service is currently deployed with throttling on, redeploy with the flag first.
- Cloud Scheduler API enabled on the project.

## Steps

1. **Create the scheduler-scaler service account.**

   ```bash
   PROJECT_ID=kindoo-prod
   SA_NAME=scheduler-scaler
   gcloud iam service-accounts create "$SA_NAME" \
     --project="$PROJECT_ID" \
     --display-name="Cloud Scheduler scaler for Cloud Run"
   gcloud run services add-iam-policy-binding kindoo-server \
     --project="$PROJECT_ID" \
     --region=us-central1 \
     --member="serviceAccount:${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com" \
     --role="roles/run.admin"
   ```

2. **Create the warm-up scheduler job.** Cron expression is for Sunday 6:30 AM America/Denver.

   ```bash
   REGION=us-central1
   SERVICE_URL="https://run.googleapis.com/v2/projects/${PROJECT_ID}/locations/${REGION}/services/kindoo-server"
   SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"

   gcloud scheduler jobs create http warm-up-sunday \
     --project="$PROJECT_ID" \
     --location="$REGION" \
     --schedule="30 6 * * 0" \
     --time-zone="America/Denver" \
     --uri="${SERVICE_URL}?updateMask=scaling" \
     --http-method=PATCH \
     --oauth-service-account-email="$SA_EMAIL" \
     --message-body='{"scaling":{"minInstanceCount":1}}'
   ```

3. **Create the scale-down scheduler job.** Sunday 10:00 PM America/Denver.

   ```bash
   gcloud scheduler jobs create http scale-down-sunday \
     --project="$PROJECT_ID" \
     --location="$REGION" \
     --schedule="0 22 * * 0" \
     --time-zone="America/Denver" \
     --uri="${SERVICE_URL}?updateMask=scaling" \
     --http-method=PATCH \
     --oauth-service-account-email="$SA_EMAIL" \
     --message-body='{"scaling":{"minInstanceCount":0}}'
   ```

4. **Add an observability alert.** If the warm-up job runs but `min-instances` doesn't actually flip to 1 (IAM drift, API quota, service unreachable), we need to know before Sunday morning.

   Add a log-based metric in `firebase/infra/metrics/` that fires when scheduler job `warm-up-sunday` has a non-2xx response. Add a corresponding alert policy in `firebase/infra/alerts/` → email Tad.

## Verification

Run the warm-up job manually and confirm the service config updated:

```bash
gcloud scheduler jobs run warm-up-sunday \
  --project="$PROJECT_ID" \
  --location="$REGION"

# Wait 30s, then:
gcloud run services describe kindoo-server \
  --project="$PROJECT_ID" \
  --region="$REGION" \
  --format="value(spec.template.metadata.annotations.'autoscaling.knative.dev/minScale')"
# Expected: 1
```

Then run scale-down and verify it drops back to 0.

## Manual warm-up (one-off event)

For a non-Sunday event (stake conference, special event):

```bash
gcloud run services update kindoo-server \
  --project="$PROJECT_ID" \
  --region="$REGION" \
  --min-instances=1

# Remember to revert:
gcloud run services update kindoo-server \
  --project="$PROJECT_ID" \
  --region="$REGION" \
  --min-instances=0
```

## Revert (disable scheduled warm-up)

If the warm-up approach turns out not to be needed, or if costs exceed expectations:

```bash
gcloud scheduler jobs delete warm-up-sunday \
  --project="$PROJECT_ID" --location="$REGION" --quiet
gcloud scheduler jobs delete scale-down-sunday \
  --project="$PROJECT_ID" --location="$REGION" --quiet
gcloud run services update kindoo-server \
  --project="$PROJECT_ID" --region="$REGION" --min-instances=0
```

## Cost expectation

Sunday-only warm window (~60 hours/month) should land within Cloud Run's free tier for a small Express container (1 vCPU, 512 MiB). Cloud Scheduler adds $0.10/month for the fourth and fifth paid jobs (beyond the 3-job free tier). Real cost: effectively free, with risk of ~$5-10/month if container sizing or traffic grows.

## Trigger for re-reconsidering (going back to F13)

If scheduled warm-up doesn't measurably improve user-reported load times after 4 weeks, disable it (above) and accept cold starts. The cost of complexity isn't worth it unless it solves a real problem.
