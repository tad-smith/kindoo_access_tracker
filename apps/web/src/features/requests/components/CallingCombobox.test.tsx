// Component tests for the CallingCombobox — the scope-aware typeahead
// behind the New Request / Edit Seat `reason` field.
//
// Focus here is the blur-close timer's lifecycle. The popover closes on
// blur after a 150ms grace period so a click on a suggestion still
// registers; that timer must never outlive the component. A pending
// timer firing post-unmount calls `setOpen` on a dead fiber, which in
// React 19 reaches `resolveUpdatePriority` -> a bare `window` read. In
// jsdom that surfaces as an unhandled `ReferenceError: window is not
// defined` once vitest has torn the environment down (B-18).

import { describe, expect, it, vi, afterEach } from 'vitest';
import { act, render, screen, fireEvent } from '@testing-library/react';
import { CallingCombobox } from './CallingCombobox';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function renderCombobox() {
  const result = render(
    <CallingCombobox value="" onChange={() => {}} scope="CO" wards={[]} data-testid="reason" />,
  );
  return { ...result, input: screen.getByTestId('reason') };
}

describe('<CallingCombobox />', () => {
  it('cancels the pending blur-close timer when the field unmounts', () => {
    vi.useFakeTimers();
    const setSpy = vi.spyOn(window, 'setTimeout');
    const clearSpy = vi.spyOn(window, 'clearTimeout');

    const { input, unmount } = renderCombobox();
    fireEvent.focus(input);
    fireEvent.blur(input);

    // The 150ms call is the blur-close timer; anything else on the tick
    // belongs to Radix/cmdk.
    const index = setSpy.mock.calls.findIndex((call) => call[1] === 150);
    expect(index).toBeGreaterThanOrEqual(0);
    const handle = setSpy.mock.results[index]?.value;

    unmount();

    expect(clearSpy).toHaveBeenCalledWith(handle);
  });

  it('closes the suggestion list 150ms after blur', () => {
    vi.useFakeTimers();
    const { input } = renderCombobox();

    act(() => {
      fireEvent.focus(input);
    });
    expect(screen.queryByTestId('reason-list')).toBeInTheDocument();

    act(() => {
      fireEvent.blur(input);
    });
    expect(screen.queryByTestId('reason-list')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(screen.queryByTestId('reason-list')).not.toBeInTheDocument();
  });
});
