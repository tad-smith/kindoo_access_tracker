// Build-version stamp surface for the web SPA.
//
// The values live in `version.gen.ts` (gitignored). At deploy time
// `infra/scripts/stamp-version.js` overwrites the gen file with the
// current git short SHA + UTC ISO build timestamp; outside of deploy
// the gen file holds the dev placeholder ('0.0.0-dev' / 'dev') seeded
// by `infra/scripts/ensure-version-gen.js` on `pnpm install`.
//
// Keeping the public surface in this committed file (and the
// stamped-only payload in `version.gen.ts`) is what lets a deploy run
// without dirtying the working tree, so the deploy guard's clean-tree
// check passes after the stamper runs.

export { KINDOO_WEB_VERSION, KINDOO_WEB_BUILT_AT } from './version.gen';
