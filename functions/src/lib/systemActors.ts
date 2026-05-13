// Synthetic actor refs for system-driven writes. Stamped on `lastActor`
// (importer + daily expiry) or substituted by the audit trigger
// (out-of-band) so the audit log picks them up via the same path real
// users take.
//
// `canonical` matches `email` for the synthetic actors — they aren't
// real email addresses, but the doc shape requires both. The web
// renderer treats these literals as automated actors and paints them
// with the `actor-automated` chip; keep all three in sync with
// `apps/web/src/features/manager/auditLog/AuditLogPage.tsx`
// (`isAutomatedActor`) and the dashboard's equivalent check.

import type { ActorRef } from '@kindoo/shared';

export const IMPORTER_ACTOR: ActorRef = {
  email: 'Importer',
  canonical: 'Importer',
};

export const EXPIRY_ACTOR: ActorRef = {
  email: 'ExpiryTrigger',
  canonical: 'ExpiryTrigger',
};

// Substituted by `auditTrigger` when a write changed tracked fields
// without touching `lastActor` — the signature of an out-of-band write
// (Firestore Console edit, ad-hoc `gcloud firestore` tweak, Admin-SDK
// script that forgot to stamp `lastActor`). Records that attribution
// is unknown rather than silently inheriting the prior writer's actor.
// See B-5 in docs/BUGS.md.
export const OUT_OF_BAND_ACTOR: ActorRef = {
  email: 'OutOfBand',
  canonical: 'OutOfBand',
};
