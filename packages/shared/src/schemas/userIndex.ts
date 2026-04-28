// `userIndexEntrySchema` mirrors `types/userIndex.ts`. The
// `userIndex/{canonicalEmail}` body — written by `onAuthUserCreate` +
// `bumpLastSignIn`. Phase 2 already ships the type; Phase 3 adds the
// matching schema for round-trip validation in tests.

import { z } from 'zod';
import { timestampLikeSchema } from './timestampLike.js';

export const userIndexEntrySchema = z.object({
  uid: z.string(),
  typedEmail: z.string(),
  lastSignIn: timestampLikeSchema,
});
