// `organizationSchema` mirrors `types/organization.ts`.

import { z } from 'zod';
import { actorRefSchema } from './actor.js';
import { timestampLikeSchema } from './timestampLike.js';

export const organizationSchema = z.object({
  organization_id: z.string(),
  name: z.string(),
  seat_cap: z.number(),

  created_at: timestampLikeSchema,
  last_modified_at: timestampLikeSchema,
  lastActor: actorRefSchema,
});
