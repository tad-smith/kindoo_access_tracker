// `wardSchema` mirrors `types/ward.ts`.

import { z } from 'zod';
import { actorRefSchema } from './actor.js';
import { timestampLikeSchema } from './timestampLike.js';

export const wardSchema = z.object({
  ward_code: z.string(),
  ward_name: z.string(),
  building_name: z.string(),
  seat_cap: z.number().int().nonnegative(),

  created_at: timestampLikeSchema,
  last_modified_at: timestampLikeSchema,
  lastActor: actorRefSchema,
});
