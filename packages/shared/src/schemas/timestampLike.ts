// `timestampLikeSchema` — structural schema for the
// `TimestampLike` shape declared in `types/userIndex.ts`. Both
// `firebase/firestore`'s `Timestamp` and `firebase-admin/firestore`'s
// `Timestamp` satisfy it; the schema is shared so every doc-level
// schema can `.refine(timestampLikeSchema, ...)` consistently.
//
// We intentionally keep the schema permissive (only the fields we
// actually inspect; methods are checked via `instanceof Function` so
// either SDK's class works without naming it). Zod's `unknown` for
// methods would lose some safety, but we only ever pass the result
// straight to Firestore, which checks the rest.

import { z } from 'zod';

export const timestampLikeSchema = z.object({
  seconds: z.number(),
  nanoseconds: z.number(),
  toDate: z.custom<() => Date>((v) => typeof v === 'function'),
  toMillis: z.custom<() => number>((v) => typeof v === 'function'),
});

export type TimestampLikeSchema = z.infer<typeof timestampLikeSchema>;
