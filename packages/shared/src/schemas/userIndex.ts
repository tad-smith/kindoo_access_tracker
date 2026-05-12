// `userIndexEntrySchema` mirrors `types/userIndex.ts`. The
// `userIndex/{canonicalEmail}` body — written by `onAuthUserCreate` +
// `bumpLastSignIn`. The optional `fcmTokens` + `notificationPrefs`
// keys carry per-user push state and are user-writable (rules permit
// self-update of just those keys).

import { z } from 'zod';
import { timestampLikeSchema } from './timestampLike.js';

export const notificationPrefsSchema = z
  .object({
    push: z
      .object({
        newRequest: z.boolean(),
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
