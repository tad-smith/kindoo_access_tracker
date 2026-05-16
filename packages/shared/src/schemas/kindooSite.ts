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
  kindoo_eid: z.number().int(),

  created_at: timestampLikeSchema,
  last_modified_at: timestampLikeSchema,
  lastActor: actorRefSchema,
});
