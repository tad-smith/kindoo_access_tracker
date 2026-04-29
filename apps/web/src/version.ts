/*
 * Build-version stamp for the web SPA.
 *
 * Stamped by `infra/scripts/stamp-version.js` at deploy time (run by both
 * `infra/scripts/deploy-staging.sh` and `deploy-prod.sh` before
 * `pnpm build`). The deploy script overwrites this file with the git
 * short SHA + UTC ISO build timestamp, mirroring the Apps Script stamper.
 *
 * The default value below is the dev placeholder — kept in source so
 * `pnpm dev` and `pnpm test` work without running the stamper. The
 * stamper exports `VERSION` and `BUILT_AT`; this file ships an
 * additional `KINDOO_WEB_VERSION` constant so the SPA topbar (and any
 * future deploy-artifact consumer in the web bundle) can render the
 * stamp for operator verification.
 *
 * If you change the export shape here, update
 * `infra/scripts/stamp-version.js` to match.
 */

export const KINDOO_WEB_VERSION = '0.0.0-dev';
