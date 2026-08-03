// Unit tests for the live temp-window revalidation hook (D25). The
// user-visible behaviour is covered in the NewRequestForm and
// EditSeatDialog component tests; this file pins the guard conditions
// directly, because getting them wrong is what would surface a
// premature "End date is required" on an untouched field.

import { describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { bothDatesReady, useLiveTempWindowCheck } from '../liveTempWindow';

describe('bothDatesReady', () => {
  it('is true only when both dates are ISO YYYY-MM-DD', () => {
    expect(bothDatesReady('2026-05-01', '2026-07-31')).toBe(true);
    expect(bothDatesReady('2026-05-01', '')).toBe(false);
    expect(bothDatesReady('', '2026-07-31')).toBe(false);
    expect(bothDatesReady('', '')).toBe(false);
    expect(bothDatesReady('2026-05-01', '2026-7-31')).toBe(false);
    expect(bothDatesReady('05/01/2026', '07/31/2026')).toBe(false);
  });
});

describe('useLiveTempWindowCheck', () => {
  function setup(initial: { enabled: boolean; startDate: string; endDate: string }) {
    const triggerEndDate = vi.fn();
    const view = renderHook(
      (props: typeof initial) => useLiveTempWindowCheck({ ...props, triggerEndDate }),
      {
        initialProps: initial,
      },
    );
    return { triggerEndDate, view };
  }

  it('does not revalidate while only one date is filled', () => {
    const { triggerEndDate, view } = setup({
      enabled: true,
      startDate: '2026-05-01',
      endDate: '',
    });
    expect(triggerEndDate).not.toHaveBeenCalled();
    view.rerender({ enabled: true, startDate: '', endDate: '2026-07-31' });
    expect(triggerEndDate).not.toHaveBeenCalled();
  });

  it('revalidates end_date once both dates are filled, and again on every change', () => {
    const { triggerEndDate, view } = setup({
      enabled: true,
      startDate: '2026-05-01',
      endDate: '',
    });
    view.rerender({ enabled: true, startDate: '2026-05-01', endDate: '2026-07-31' });
    expect(triggerEndDate).toHaveBeenCalledTimes(1);
    expect(triggerEndDate).toHaveBeenCalledWith('end_date');
    // Correcting the window re-runs the check — that re-run is what
    // clears the error without a submit.
    view.rerender({ enabled: true, startDate: '2026-05-01', endDate: '2026-07-30' });
    expect(triggerEndDate).toHaveBeenCalledTimes(2);
  });

  it('does not re-run when nothing about the dates changed', () => {
    const { triggerEndDate, view } = setup({
      enabled: true,
      startDate: '2026-05-01',
      endDate: '2026-07-31',
    });
    expect(triggerEndDate).toHaveBeenCalledTimes(1);
    // `trigger` writes form state, which re-renders the form. A
    // dependency on form state instead of the date values would loop
    // here.
    view.rerender({ enabled: true, startDate: '2026-05-01', endDate: '2026-07-31' });
    view.rerender({ enabled: true, startDate: '2026-05-01', endDate: '2026-07-31' });
    expect(triggerEndDate).toHaveBeenCalledTimes(1);
  });

  it('stays inert for a full user', () => {
    const { triggerEndDate, view } = setup({
      enabled: false,
      startDate: '2026-01-01',
      endDate: '2026-07-20',
    });
    expect(triggerEndDate).not.toHaveBeenCalled();
    view.rerender({ enabled: false, startDate: '2026-01-01', endDate: '2026-12-31' });
    expect(triggerEndDate).not.toHaveBeenCalled();
  });
});
