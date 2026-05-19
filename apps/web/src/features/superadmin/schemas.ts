// Zod schemas for superadmin-facing forms. Currently a single form —
// Create Stake — whose shape mirrors the `createStake` callable's
// `CreateStakeInput`. The callable itself re-validates and applies the
// authoritative slug rule; the client schema only catches obvious
// empties before burning a round-trip.

import { z } from 'zod';

/** Default IANA tz when the operator doesn't override. Matches the
 *  server-side default in `createStake.ts`. */
export const DEFAULT_TIMEZONE = 'America/Denver';

export const createStakeSchema = z.object({
  stake_name: z.string().trim().min(1, 'Stake name is required.'),
  bootstrap_admin_email: z
    .string()
    .trim()
    .min(1, 'Bootstrap admin email is required.')
    .email('Enter a valid email address.'),
  // Timezone is optional in the callable; the form supplies a default
  // (`DEFAULT_TIMEZONE`) so the field is non-empty in practice, but we
  // accept the empty string and let the callable fill in the default.
  timezone: z.string().trim(),
});

export type CreateStakeForm = z.infer<typeof createStakeSchema>;
