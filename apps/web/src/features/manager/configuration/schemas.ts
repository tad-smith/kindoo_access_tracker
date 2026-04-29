// Zod schemas for Configuration sub-form inputs. Mirror the `hooks.ts`
// mutation-input types so react-hook-form's resolver gives the same
// types back to the form component.
//
// Numeric fields use `z.number()` (not `z.coerce.number()`) — the form
// uses `register(field, { valueAsNumber: true })` for those, so by the
// time the resolver runs the value is already a number. This keeps the
// schema's input type identical to the output type, which RHF's typed
// `useForm<T>()` requires under exactOptionalPropertyTypes.

import { z } from 'zod';

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

export const buildingSchema = z.object({
  building_name: z.string().trim().min(1, 'Building name is required.'),
  address: z.string().trim(),
});
export type BuildingForm = z.infer<typeof buildingSchema>;

// `active` is no longer a form input — the add-manager form always
// creates managers with `active: true`. Toggling existing managers
// happens via the deactivate / activate row buttons. The persisted
// `KindooManager.active` field is retained on the schema in
// packages/shared because the claim-sync trigger keys off it.
export const managerSchema = z.object({
  member_email: z.string().trim().min(1, 'Email is required.').email('Must be a valid email.'),
  name: z.string().trim().min(1, 'Name is required.'),
});
export type ManagerForm = z.infer<typeof managerSchema>;

export const callingTemplateSchema = z.object({
  calling_name: z.string().trim().min(1, 'Calling name is required.'),
  give_app_access: z.boolean(),
  sheet_order: z.number({ message: 'Sheet order must be a number.' }).int(),
});
export type CallingTemplateForm = z.infer<typeof callingTemplateSchema>;

export const importDaySchema = z.enum([
  'MONDAY',
  'TUESDAY',
  'WEDNESDAY',
  'THURSDAY',
  'FRIDAY',
  'SATURDAY',
  'SUNDAY',
]);

export const configSchema = z.object({
  stake_name: z.string().trim().min(1, 'Stake name is required.'),
  callings_sheet_id: z.string().trim().min(1, 'Callings sheet ID is required.'),
  stake_seat_cap: z
    .number({ message: 'Seat cap must be a number.' })
    .int()
    .min(0, 'Seat cap must be 0 or greater.'),
  expiry_hour: z.number().int().min(0).max(23),
  import_day: importDaySchema,
  import_hour: z.number().int().min(0).max(23),
  timezone: z.string().trim().min(1, 'Timezone is required.'),
  notifications_enabled: z.boolean(),
});
export type ConfigForm = z.infer<typeof configSchema>;
