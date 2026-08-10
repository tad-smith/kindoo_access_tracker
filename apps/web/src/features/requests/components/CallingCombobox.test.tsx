// Component tests for the CallingCombobox — the scope-aware typeahead
// behind the New Request / Edit Seat `reason` field.
//
// Two behaviours are pinned here.
//
// WHEN THE POPOVER OPENS (B-27). Only on a deliberate ask: a keystroke,
// or ArrowDown / ArrowUp. Focus alone must not open it. `EditSeatDialog` is a Radix Dialog, which autofocuses its
// first field on mount — an `onFocus` that opened the list therefore
// covered the buildings checklist before the operator touched anything.
// The no-interaction case had no coverage at all, which is why it
// shipped, so the first test below renders and asserts nothing is shown.
//
// THE BLUR-CLOSE TIMER'S LIFECYCLE. The popover closes on blur after a
// 150ms grace period so a click on a suggestion still registers; that
// timer must never outlive the component. A pending timer firing
// post-unmount calls `setOpen` on a dead fiber, which in React 19
// reaches `resolveUpdatePriority` -> a bare `window` read. In jsdom that
// surfaces as an unhandled `ReferenceError: window is not defined` once
// vitest has torn the environment down (B-18).

import { useState } from 'react';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { act, render, screen, fireEvent } from '@testing-library/react';
import { CallingCombobox } from './CallingCombobox';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/**
 * Renders the combobox as a controlled field over real state, so typing
 * updates `value` the way react-hook-form's `Controller` does. `scope`
 * is a ward code with an empty catalogue, which falls back to the full
 * union — every assertion below names a calling in it.
 */
function renderCombobox(initialValue = '') {
  function Host() {
    const [value, setValue] = useState(initialValue);
    return (
      <CallingCombobox
        value={value}
        onChange={setValue}
        scope="CO"
        wards={[]}
        data-testid="reason"
      />
    );
  }
  const result = render(<Host />);
  return { ...result, input: screen.getByTestId('reason') as HTMLInputElement };
}

const list = () => screen.queryByTestId('reason-list');
const option = (calling: string) => screen.queryByTestId(`reason-option-${calling}`);

describe('<CallingCombobox />', () => {
  it('shows no suggestions when the field is focused but nothing has been typed', () => {
    const { input } = renderCombobox();

    // The state a Radix Dialog puts the field in the moment it mounts.
    act(() => {
      input.focus();
      fireEvent.focus(input);
    });

    expect(input).toHaveFocus();
    expect(list()).not.toBeInTheDocument();
    expect(option('Bishop')).not.toBeInTheDocument();
  });

  it('shows no suggestions on a focused field that already carries a value', () => {
    // Edit Seat opens with the seat's current calling pre-filled; a
    // non-empty value is not an ask for suggestions either.
    const { input } = renderCombobox('Ward Clerk');

    act(() => {
      input.focus();
      fireEvent.focus(input);
    });

    expect(list()).not.toBeInTheDocument();
  });

  it('shows matching suggestions once the user types', () => {
    const { input } = renderCombobox();

    act(() => {
      fireEvent.focus(input);
      fireEvent.change(input, { target: { value: 'Bish' } });
    });

    expect(list()).toBeInTheDocument();
    expect(option('Bishop')).toBeInTheDocument();
  });

  it('opens the suggestion list on ArrowDown from an empty focused field', () => {
    const { input } = renderCombobox();

    act(() => {
      fireEvent.focus(input);
      fireEvent.keyDown(input, { key: 'ArrowDown' });
    });

    expect(list()).toBeInTheDocument();
    expect(option('Bishop')).toBeInTheDocument();
  });

  it('filters an arrow-opened list by the text already in the field', () => {
    // How the popover was opened does not change what it shows — cmdk
    // filters on `value` whenever the list is mounted. Edit Seat
    // pre-fills `reason` with the seat's calling, so the arrows there
    // open a list already narrowed to it, never the whole scope list.
    const { input } = renderCombobox('Bishop');

    act(() => {
      fireEvent.focus(input);
      fireEvent.keyDown(input, { key: 'ArrowDown' });
    });

    expect(list()).toBeInTheDocument();
    expect(option('Bishop')).toBeInTheDocument();
    expect(option('Relief Society President')).not.toBeInTheDocument();
  });

  it('opens the suggestion list on ArrowUp from an empty focused field', () => {
    const { input } = renderCombobox();

    act(() => {
      fireEvent.focus(input);
      fireEvent.keyDown(input, { key: 'ArrowUp' });
    });

    expect(list()).toBeInTheDocument();
  });

  it('closes the list and leaves it closed after a suggestion is picked', () => {
    // `handleSelect` refocuses the input so keyboard editing continues.
    // With a focus-opens-the-popover handler that refocus is one
    // `setOpen(true)` away from reopening the list on top of the form;
    // Radix happens to dismiss first (the input is OUTSIDE the popover
    // content, so re-focusing it reads as a focus-outside), which is
    // why the old code never surfaced it. Pin the outcome so neither
    // half can regress into it.
    vi.useFakeTimers();
    const { input } = renderCombobox();

    act(() => {
      input.focus();
      fireEvent.change(input, { target: { value: 'Bish' } });
    });
    const bishop = option('Bishop');
    expect(bishop).toBeInTheDocument();

    act(() => {
      // A mouse pick blurs the input before the item's handler runs;
      // `handleSelect` then puts focus back, which is the transition
      // that used to re-open the list.
      input.blur();
      fireEvent.click(bishop!);
    });

    expect(input.value).toBe('Bishop');
    expect(list()).not.toBeInTheDocument();

    // And it stays closed past the blur timer's window.
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(list()).not.toBeInTheDocument();
  });

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
      fireEvent.change(input, { target: { value: 'Bish' } });
    });
    expect(list()).toBeInTheDocument();

    act(() => {
      fireEvent.blur(input);
    });
    expect(list()).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(list()).not.toBeInTheDocument();
  });
});
