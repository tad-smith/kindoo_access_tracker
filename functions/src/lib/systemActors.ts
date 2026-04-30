// Synthetic actor refs for system-driven Admin SDK writes (importer +
// daily expiry). Stamped on `lastActor` so the audit trigger picks them
// up via the same path real users take.
//
// `canonical` matches `email` for the synthetic actors — they aren't
// real email addresses, but the doc shape requires both.

import type { ActorRef } from '@kindoo/shared';

export const IMPORTER_ACTOR: ActorRef = {
  email: 'Importer',
  canonical: 'Importer',
};

export const EXPIRY_ACTOR: ActorRef = {
  email: 'ExpiryTrigger',
  canonical: 'ExpiryTrigger',
};
