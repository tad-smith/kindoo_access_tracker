// Zod schema for `ActorRef` — the `{ email, canonical }` integrity-check
// pair carried on every domain doc's `lastActor` field. Mirrors
// `types/actor.ts`.

import { z } from 'zod';

export const actorRefSchema = z.object({
  email: z.string(),
  canonical: z.string(),
});

export type ActorRefSchema = z.infer<typeof actorRefSchema>;
