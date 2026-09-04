// `userIndexEntrySchema` mirrors `types/userIndex.ts`. The
// `userIndex/{canonicalEmail}` body — written by `onAuthUserCreate` +
// `bumpLastSignIn`. The optional `fcmTokens` + `notificationPrefs`
// keys carry per-user push state and are user-writable (rules permit
// self-update of just those keys).

import { z } from 'zod';
import { timestampLikeSchema } from './timestampLike.js';

// Every category key is optional — a merge-write of one category
// leaves the others absent, and absent reads as off. See
// `types/userIndex.ts` for why `syncReminder` is its own opt-in.
export const notificationPrefsSchema = z
  .object({
    push: z
      .object({
        newRequest: z.boolean().optional(),
        syncReminder: z.boolean().optional(),
      })
      .optional(),
  })
  .optional();

export const userIndexEntrySchema = z.object({
  uid: z.string(),
  typedEmail: z.string(),
  lastSignIn: timestampLikeSchema,
  fcmTokens: z.record(z.string(), z.string()).optional(),
  notificationPrefs: notificationPrefsSchema,
});
