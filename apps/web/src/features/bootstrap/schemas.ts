// Zod schemas for bootstrap-wizard form inputs. Each step's form uses
// react-hook-form + zod resolver against the matching schema. The
// schemas mirror the per-step write surface in `hooks.ts`.
//
// Numeric fields use `z.number()` (not `z.coerce.number()`) — the form
// uses `register(field, { valueAsNumber: true })` for those so the
// resolver sees a `number` already. Keeping the schema's input type
// identical to the output type is what RHF's typed `useForm<T>()`
// requires under `exactOptionalPropertyTypes`.

import { z } from 'zod';

// `callings_sheet_id` is optional — operators can leave it blank in the
// wizard and fill it in later from the Configuration page once the
// Sheet is set up.
export const step1Schema = z.object({
  stake_name: z.string().trim().min(1, 'Stake name is required.'),
  callings_sheet_id: z.string().trim().optional(),
  stake_seat_cap: z
    .number({ message: 'Seat cap must be a number.' })
    .int('Seat cap must be an integer.')
    .min(0, 'Seat cap must be 0 or greater.'),
});

export type Step1Form = z.infer<typeof step1Schema>;

export const buildingSchema = z.object({
  building_name: z.string().trim().min(1, 'Building name is required.'),
  address: z.string().trim(),
});

export type BuildingForm = z.infer<typeof buildingSchema>;

export const wardSchema = z.object({
  ward_code: z
    .string()
    .trim()
    .min(1, 'Ward code is required.')
    .max(8, 'Ward code is too long.')
    .regex(/^[A-Za-z0-9]+$/, 'Ward code is letters/digits only.'),
  ward_name: z.string().trim().min(1, 'Ward name is required.'),
  building_name: z.string().trim().min(1, 'Building is required.'),
  seat_cap: z
    .number({ message: 'Seat cap must be a number.' })
    .int('Seat cap must be an integer.')
    .min(0, 'Seat cap must be 0 or greater.'),
});

export type WardForm = z.infer<typeof wardSchema>;

// `active` is no longer a form input — new managers default to active.
// The field is preserved on the persisted shape (`KindooManager.active`)
// because the claim-sync trigger keys off it; toggling active state is
// the Configuration page's deactivate / activate flow rather than a
// form field on add.
export const managerSchema = z.object({
  member_email: z.string().trim().min(1, 'Email is required.').email('Must be a valid email.'),
  name: z.string().trim().min(1, 'Name is required.'),
});

export type ManagerForm = z.infer<typeof managerSchema>;
