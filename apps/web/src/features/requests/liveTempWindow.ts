// Live revalidation of the limited-access temp-window cap (D25), shared
// by `NewRequestForm` (add_temp) and `EditSeatDialog` (edit_temp).
//
// The ≤90-day cap lives in the zod schemas, so `LIMITED_TEMP_WINDOW_MESSAGE`
// only reaches the user on submit. A limited user picking dates should
// learn the window is too long the moment the second date lands, not
// after a failed submit — so this hook re-runs validation for `end_date`
// alone whenever either date changes.
//
// Why `trigger` and not inline arithmetic: the schema stays the one place
// the 90-day rule is expressed, and the error renders through the
// existing `formState.errors.end_date` element under the End date field.
// No second message, no duplicated boundary to drift.
//
// Deliberately narrow, because the alternative — `useForm({ mode:
// 'onChange' })` — would start erroring email / name / reason mid-typing
// on every form, a far larger behavioural change than asked for:
//
//   - `enabled` is false for a full user and for non-temp request types,
//     so their forms keep submit-time validation exactly as it was;
//   - BOTH dates must be present and ISO-shaped before the first
//     trigger. Firing on a half-filled pair would surface "End date is
//     required" on a field the user hasn't reached yet.
//
// `trigger('end_date')` sets OR CLEARS that field's error (react-hook-form
// unsets the entry when the named path validates clean), so pulling the
// window back under the cap removes the message without a submit.
//
// The effect depends on the watched date VALUES, never on `formState` —
// `trigger` writes form state, so a `formState` dependency would re-enter.

import { useEffect } from 'react';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface LiveTempWindowCheckOptions {
  /** Limited principal AND a temp request type. False → inert. */
  enabled: boolean;
  /** Current `start_date` field value. */
  startDate: string;
  /** Current `end_date` field value. */
  endDate: string;
  /**
   * react-hook-form's `trigger`, narrowed to the single field this hook
   * revalidates. Both `UseFormTrigger<NewRequestForm>` and
   * `UseFormTrigger<EditSeatForm>` are assignable; the identity is
   * stable across renders, so it is a safe effect dependency.
   */
  triggerEndDate: (name: 'end_date') => unknown;
}

/** Both dates filled in and well-formed — the gate for firing at all. */
export function bothDatesReady(startDate: string, endDate: string): boolean {
  return ISO_DATE.test(startDate) && ISO_DATE.test(endDate);
}

export function useLiveTempWindowCheck({
  enabled,
  startDate,
  endDate,
  triggerEndDate,
}: LiveTempWindowCheckOptions): void {
  useEffect(() => {
    if (!enabled) return;
    if (!bothDatesReady(startDate, endDate)) return;
    void triggerEndDate('end_date');
  }, [enabled, startDate, endDate, triggerEndDate]);
}
