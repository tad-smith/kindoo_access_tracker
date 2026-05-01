// `accessSchema` mirrors `types/access.ts`. The split-ownership
// boundary lives in `manualGrantSchema` (manager-owned) vs the bare
// `Record<string, string[]>` of `importer_callings` (importer-owned).

import { z } from 'zod';
import { actorRefSchema } from './actor.js';
import { timestampLikeSchema } from './timestampLike.js';

export const manualGrantSchema = z.object({
  grant_id: z.string(),
  reason: z.string(),
  granted_by: actorRefSchema,
  granted_at: timestampLikeSchema,
});

export const accessSchema = z.object({
  member_canonical: z.string(),
  member_email: z.string(),
  member_name: z.string(),

  importer_callings: z.record(z.string(), z.array(z.string())),
  manual_grants: z.record(z.string(), z.array(manualGrantSchema)),

  sort_order: z.number().nullable().optional(),

  created_at: timestampLikeSchema,
  last_modified_at: timestampLikeSchema,
  last_modified_by: actorRefSchema,
  lastActor: actorRefSchema,
});
