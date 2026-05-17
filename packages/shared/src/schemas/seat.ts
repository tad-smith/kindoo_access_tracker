// `seatSchema` mirrors `types/seat.ts`. The schema is permissive about
// optional fields (manual/temp seats omit some, auto seats omit
// others); the rules + Cloud Function code enforce per-type presence
// invariants.

import { z } from 'zod';
import { actorRefSchema } from './actor.js';
import { timestampLikeSchema } from './timestampLike.js';

export const seatTypeSchema = z.enum(['auto', 'manual', 'temp']);

/** ISO date `YYYY-MM-DD` — temp seat fields. */
const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');

export const duplicateGrantSchema = z.object({
  scope: z.string(),
  type: seatTypeSchema,
  callings: z.array(z.string()).optional(),
  reason: z.string().optional(),
  start_date: isoDateSchema.optional(),
  end_date: isoDateSchema.optional(),
  building_names: z.array(z.string()).optional(),
  // T-42: `null` / absent means home site; a string is a doc id under
  // `stakes/{stakeId}/kindooSites/`. Required on parallel-site
  // duplicates (those whose value differs from the seat's primary);
  // within-site duplicates may still leave it unset.
  kindoo_site_id: z.string().nullable().optional(),
  detected_at: timestampLikeSchema,
});

export const seatSchema = z.object({
  member_canonical: z.string(),
  member_email: z.string(),
  member_name: z.string(),

  scope: z.string(),
  type: seatTypeSchema,
  callings: z.array(z.string()),
  reason: z.string().optional(),
  start_date: isoDateSchema.optional(),
  end_date: isoDateSchema.optional(),
  building_names: z.array(z.string()),

  granted_by_request: z.string().optional(),

  sort_order: z.number().nullable().optional(),

  // T-42: same shape as the ward/building convention. `null` / absent
  // means home site. Top-level reflects the primary grant's site;
  // duplicates carry their own `kindoo_site_id`.
  kindoo_site_id: z.string().nullable().optional(),

  duplicate_grants: z.array(duplicateGrantSchema),
  // T-42 / T-43: denormalised mirror of `duplicate_grants[].scope` —
  // Firestore CEL needs a primitive-string array to use `in` /
  // `hasAny` predicates. Server-maintained; clients never write it.
  duplicate_scopes: z.array(z.string()).optional(),

  created_at: timestampLikeSchema,
  last_modified_at: timestampLikeSchema,
  last_modified_by: actorRefSchema,
  lastActor: actorRefSchema,
});
