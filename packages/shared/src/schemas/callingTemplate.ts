// `callingTemplateSchema` — same shape under both
// `wardCallingTemplates/{name}` and `stakeCallingTemplates/{name}`.

import { z } from 'zod';
import { actorRefSchema } from './actor.js';
import { timestampLikeSchema } from './timestampLike.js';

export const callingTemplateSchema = z.object({
  calling_name: z.string(),
  give_app_access: z.boolean(),
  auto_kindoo_access: z.boolean(),
  sheet_order: z.number().int().nonnegative(),
  created_at: timestampLikeSchema,
  lastActor: actorRefSchema,
});

/** Alias — Ward and Stake calling templates share the schema. */
export const wardCallingTemplateSchema = callingTemplateSchema;
export const stakeCallingTemplateSchema = callingTemplateSchema;
