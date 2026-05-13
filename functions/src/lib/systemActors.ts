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

// Stamped by `removeSeatOnRequestComplete` when it edits or deletes a
// seat in response to a completed remove request. The human completer
// attribution lives on the request doc; this synthetic actor surfaces
// the seat-side write as automated so the audit log can distinguish
// "manager flipped the request" from "trigger reconciled the seat."
export const REMOVE_TRIGGER_ACTOR: ActorRef = {
  email: 'RemoveTrigger',
  canonical: 'RemoveTrigger',
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
