// `buildingSchema` mirrors `types/building.ts`.

import { z } from 'zod';
import { actorRefSchema } from './actor.js';
import { timestampLikeSchema } from './timestampLike.js';

export const buildingSchema = z.object({
  building_id: z.string(),
  building_name: z.string(),
  address: z.string(),
  // Kindoo Sites — `null` (or absent) means the home site; a string
  // points at a doc id under `stakes/{stakeId}/kindooSites/`.
  kindoo_site_id: z.string().nullable().optional(),

  created_at: timestampLikeSchema,
  last_modified_at: timestampLikeSchema,
  lastActor: actorRefSchema,
});
