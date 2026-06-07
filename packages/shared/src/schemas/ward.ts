// `wardSchema` mirrors `types/ward.ts`.

import { z } from 'zod';
import { actorRefSchema } from './actor.js';
import { timestampLikeSchema } from './timestampLike.js';

export const wardSchema = z.object({
  // Doc ID. A `buildingSlug()`-derived slug at create (lowercase alnum +
  // internal hyphens, e.g. `3rd-ward`); legacy 2-letter uppercase codes
  // (e.g. `CO`) are retained on existing wards. The regex accepts both:
  // alnum (either case) runs joined by single hyphens, no leading /
  // trailing hyphen.
  ward_code: z.string().regex(/^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/),
  ward_name: z.string(),
  // Preferred slug FK; optional during the additive transition.
  building_id: z.string().optional(),
  // Legacy display-name FK + display snapshot; still required.
  building_name: z.string(),
  seat_cap: z.number().int().nonnegative(),

  created_at: timestampLikeSchema,
  last_modified_at: timestampLikeSchema,
  lastActor: actorRefSchema,
});
