// `stakeSchema` mirrors `types/stake.ts`. The
// `stakes/{stakeId}` parent doc — see `firebase-schema.md` §4.1.

import { z } from 'zod';
import { actorRefSchema } from './actor.js';
import { timestampLikeSchema } from './timestampLike.js';

export const importDaySchema = z.enum([
  'MONDAY',
  'TUESDAY',
  'WEDNESDAY',
  'THURSDAY',
  'FRIDAY',
  'SATURDAY',
  'SUNDAY',
]);

export const overCapEntrySchema = z.object({
  pool: z.string(),
  count: z.number().int().nonnegative(),
  cap: z.number().int().nonnegative(),
  over_by: z.number().int(),
});

export const stakeSchema = z.object({
  stake_id: z.string(),
  stake_name: z.string(),
  created_at: timestampLikeSchema,
  created_by: z.string(),

  callings_sheet_id: z.string(),
  bootstrap_admin_email: z.string(),
  setup_complete: z.boolean(),

  stake_seat_cap: z.number().int().nonnegative(),

  expiry_hour: z.number().int().min(0).max(23),
  import_day: importDaySchema,
  import_hour: z.number().int().min(0).max(23),
  timezone: z.string(),

  notifications_enabled: z.boolean(),

  last_over_caps_json: z.array(overCapEntrySchema),
  last_import_at: timestampLikeSchema.optional(),
  last_import_summary: z.string().optional(),
  last_expiry_at: timestampLikeSchema.optional(),
  last_expiry_summary: z.string().optional(),

  last_modified_at: timestampLikeSchema,
  last_modified_by: actorRefSchema,
  lastActor: actorRefSchema,
});
