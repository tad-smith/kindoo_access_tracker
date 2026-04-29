// Stamped by infra/scripts/stamp-version.js at deploy time.
//
// During development this file holds the placeholder `0.0.0-dev`. The
// deploy scripts (deploy-staging.sh, deploy-prod.sh) overwrite this
// file before each build with the current git short SHA so the Cloud
// Functions deploy artifact carries an identifiable build stamp; an
// operator can confirm the served bundle matches the most recent
// deploy by comparing the value committed here to function logs.
export const KINDOO_FUNCTIONS_VERSION = '0.0.0-dev';
