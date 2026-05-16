// `kindooSiteSchema` mirrors `types/kindooSite.ts`. The
// `stakes/{stakeId}/kindooSites/{kindooSiteId}` doc — see
// `firebase-schema.md` §4.N (Kindoo Sites).

import { z } from 'zod';
import { actorRefSchema } from './actor.js';
import { timestampLikeSchema } from './timestampLike.js';

export const kindooSiteSchema = z.object({
  id: z.string(),
  display_name: z.string(),
  kindoo_expected_site_name: z.string(),
  // Populated by the extension at first use; manager UI does not set
  // this field. `.nullable().optional()` matches the convention used
  // by `kindoo_site_id` on Ward / Building.
  kindoo_eid: z.number().int().nullable().optional(),

  created_at: timestampLikeSchema,
  last_modified_at: timestampLikeSchema,
  lastActor: actorRefSchema,
});
