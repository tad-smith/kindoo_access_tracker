// Shared Firebase Functions param declarations.
//
// `defineString(name, ...)` returns the same param object across imports
// (Firebase keys params by name internally), so multiple files can call
// it safely. Centralising the declaration here keeps the description /
// default in one spot and makes the consumer surface obvious.
//
// `WEB_BASE_URL` is consumed in two places:
//   - trigger function-options blocks (declared so Firebase deploy
//     surfaces the param to the operator and stashes it in
//     `.env.<projectId>`);
//   - `EmailService.buildLink()` at runtime via `.value()`.

import { defineString } from 'firebase-functions/params';

export const WEB_BASE_URL = defineString('WEB_BASE_URL', {
  description:
    'Base URL of the web app (e.g. https://stakebuildingaccess.org). Used in email body deep-links.',
});
