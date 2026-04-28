// `kindooManagerSchema` mirrors `types/kindooManager.ts`.

import { z } from 'zod';
import { actorRefSchema } from './actor.js';
import { timestampLikeSchema } from './timestampLike.js';

export const kindooManagerSchema = z.object({
  member_canonical: z.string(),
  member_email: z.string(),
  name: z.string(),
  active: z.boolean(),

  added_at: timestampLikeSchema,
  added_by: actorRefSchema,
  lastActor: actorRefSchema,
});
