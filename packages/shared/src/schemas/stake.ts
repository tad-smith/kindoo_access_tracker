// `stakeSchema` mirrors `types/stake.ts`. The
// `stakes/{stakeId}` parent doc — see `firebase-schema.md` §4.1.

import { z } from 'zod';
import { actorRefSchema } from './actor.js';
import { timestampLikeSchema } from './timestampLike.js';

export const overCapEntrySchema = z.object({
  pool: z.string(),
  count: z.number().int().nonnegative(),
  cap: z.number().int().nonnegative(),
  over_by: z.number().int(),
});

export const stakeSchema = z.object({
  // Identity is the Firestore doc id (the slug); there is no stored id field.
  stake_name: z.string(),
  created_at: timestampLikeSchema,
  created_by: z.string(),

  bootstrap_admin_email: z.string(),
  setup_complete: z.boolean(),

  stake_seat_cap: z.number().int().nonnegative(),

  timezone: z.string(),

  notifications_enabled: z.boolean(),

  last_over_caps_json: z.array(overCapEntrySchema),

  last_modified_at: timestampLikeSchema,
  last_modified_by: actorRefSchema,
  lastActor: actorRefSchema,
});
