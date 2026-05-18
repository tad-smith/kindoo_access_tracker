// Zod schemas for the auth feature's forms. Used via
// react-hook-form's `zodResolver` from `@hookform/resolvers/zod`.
//
// Single source of truth for client-side email validation on the
// sign-in surfaces. The Firebase SDK does its own server-side
// validation; the schema only needs to catch empty / obviously
// malformed entries before we burn an SDK round-trip.

import { z } from 'zod';

// `z.string().email()` covers the empty-string case implicitly because
// an empty string is not a valid email per the spec — but the message
// is generic ("Invalid email"), so we surface a friendlier "required"
// message first. The `min(1)` runs before `.email()`, so a blank
// submit shows "Enter your email address." rather than the format
// message.
export const signInEmailSchema = z.object({
  email: z
    .string()
    .trim()
    .min(1, 'Enter your email address.')
    .email('Enter a valid email address.'),
});

export type SignInEmailForm = z.infer<typeof signInEmailSchema>;
