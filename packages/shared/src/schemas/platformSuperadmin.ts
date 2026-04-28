// `platformSuperadminSchema` mirrors `types/platformSuperadmin.ts`.

import { z } from 'zod';
import { timestampLikeSchema } from './timestampLike.js';

export const platformSuperadminSchema = z.object({
  email: z.string(),
  addedAt: timestampLikeSchema,
  addedBy: z.string(),
  notes: z.string().optional(),
});
