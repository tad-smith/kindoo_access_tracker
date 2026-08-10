// Component tests for the Dialog primitive. Uses @testing-library/user-event
// to drive ESC key handling and focus assertions, both of which are
// the headline accessibility requirements per the migration plan.
//
// Radix Dialog handles focus-trap + ESC for us; these tests exist to
// (a) catch a future refactor that drops the Radix layer, and (b)
// document the expected behaviour for downstream pages.

import { describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Dialog } from './Dialog';

function Harness({ initialOpen = false }: { initialOpen?: boolean }) {
  const [open, setOpen] = useState(initialOpen);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open
      </button>
      <Dialog open={open} onOpenChange={setOpen} title="Confirm" description="Body content.">
        <p>Are you sure?</p>
        <Dialog.Footer>
          <Dialog.CancelButton>Cancel</Dialog.CancelButton>
          <Dialog.ConfirmButton onClick={() => setOpen(false)}>Confirm</Dialog.ConfirmButton>
        </Dialog.Footer>
      </Dialog>
    </>
  );
}

/** A dialog whose first field arrives pre-filled — the shape B-28 is about. */
function PrefilledHarness({
  initialOpen = false,
  autoFocusFirstField,
}: {
  initialOpen?: boolean;
  autoFocusFirstField?: boolean;
}) {
  const [open, setOpen] = useState(initialOpen);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open
      </button>
      <button type="button" data-testid="outside">
        Outside
      </button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Edit seat"
        {...(autoFocusFirstField === undefined ? {} : { autoFocusFirstField })}
      >
        <input data-testid="calling" defaultValue="Ward Clerk" />
        <input data-testid="comment" defaultValue="" />
        <Dialog.Footer>
          <Dialog.CancelButton>Cancel</Dialog.CancelButton>
        </Dialog.Footer>
      </Dialog>
    </>
  );
}

describe('Dialog', () => {
  it('does not render content when closed', () => {
    render(<Harness />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('renders title + description when open', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: /^Open$/ }));
    const dialog = screen.getByRole('dialog');
    expect(dialog).toBeInTheDocument();
    // The title is rendered as an h2 by Radix; query within the dialog.
    expect(dialog).toHaveAccessibleName('Confirm');
    expect(screen.getByText('Body content.')).toBeInTheDocument();
  });

  it('closes when ESC is pressed', async () => {
    const user = userEvent.setup();
    render(<Harness initialOpen />);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('closes when the Cancel button is clicked', async () => {
    const user = userEvent.setup();
    render(<Harness initialOpen />);
    await user.click(screen.getByRole('button', { name: /Cancel/ }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('moves focus into the dialog when opening', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const opener = screen.getByRole('button', { name: /Open/ });
    await user.click(opener);
    // Radix moves focus to the first focusable child; for our footer
    // that's the Cancel button. The exact focused element doesn't
    // matter — what matters is that focus is no longer on the opener.
    expect(document.activeElement).not.toBe(opener);
    const dialog = screen.getByRole('dialog');
    // active element should be inside the dialog.
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it('does not close on Escape when dismissable is false', async () => {
    const user = userEvent.setup();
    function LockedHarness() {
      const [open, setOpen] = useState(true);
      return (
        <Dialog open={open} onOpenChange={setOpen} title="Locked" dismissable={false}>
          <p>Working…</p>
          <Dialog.Footer>
            <Dialog.CancelButton>Cancel</Dialog.CancelButton>
          </Dialog.Footer>
        </Dialog>
      );
    }
    render(<LockedHarness />);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    // Still open — the implicit dismissal gesture was blocked.
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('still closes via the Cancel button when dismissable is false', async () => {
    const user = userEvent.setup();
    function LockedHarness() {
      const [open, setOpen] = useState(true);
      return (
        <Dialog open={open} onOpenChange={setOpen} title="Locked" dismissable={false}>
          <Dialog.Footer>
            <Dialog.CancelButton>Cancel</Dialog.CancelButton>
          </Dialog.Footer>
        </Dialog>
      );
    }
    render(<LockedHarness />);
    // The explicit Close affordance keeps working even when locked.
    await user.click(screen.getByRole('button', { name: /Cancel/ }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('focuses the first field and selects its text by default', async () => {
    // Pins Radix's default so a future change to `autoFocusFirstField`'s
    // default is caught here rather than in whichever dialog notices.
    const user = userEvent.setup();
    render(<PrefilledHarness />);
    await user.click(screen.getByRole('button', { name: /^Open$/ }));
    const field = screen.getByTestId('calling') as HTMLInputElement;
    expect(document.activeElement).toBe(field);
    expect(field.selectionStart).toBe(0);
    expect(field.selectionEnd).toBe('Ward Clerk'.length);
  });

  it('calls onOpenChange(false) when the dialog closes', async () => {
    const onOpenChange = vi.fn();
    function ControlledHarness() {
      return (
        <Dialog open onOpenChange={onOpenChange} title="X">
          <Dialog.Footer>
            <Dialog.CancelButton>Cancel</Dialog.CancelButton>
          </Dialog.Footer>
        </Dialog>
      );
    }
    const user = userEvent.setup();
    render(<ControlledHarness />);
    await user.keyboard('{Escape}');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

// B-28. Suppressing Radix's mount autofocus is easy; suppressing it
// without breaking the focus trap, Escape-from-mount, and the screen
// reader announcement is the part that needs pinning. A bare
// `e.preventDefault()` leaves focus on the trigger behind the overlay
// and fails the trap + announcement assertions below.
describe('Dialog with autoFocusFirstField={false}', () => {
  it('opens with no field focused and no text selected', async () => {
    const user = userEvent.setup();
    render(<PrefilledHarness autoFocusFirstField={false} />);
    await user.click(screen.getByRole('button', { name: /^Open$/ }));
    const field = screen.getByTestId('calling') as HTMLInputElement;
    expect(document.activeElement).not.toBe(field);
    // Nothing anywhere in the dialog holds focus.
    expect(screen.getByRole('dialog').querySelector(':focus')).toBeNull();
    // And the pre-filled value is not selected — a collapsed range.
    expect(field.selectionStart).toBe(field.selectionEnd);
  });

  it('still moves focus into the dialog so screen readers announce it', async () => {
    const user = userEvent.setup();
    render(<PrefilledHarness autoFocusFirstField={false} />);
    const opener = screen.getByRole('button', { name: /^Open$/ });
    await user.click(opener);
    const dialog = screen.getByRole('dialog');
    // Focus lands on the dialog node itself — not left on the trigger
    // behind the overlay, which is what a bare preventDefault would do.
    expect(document.activeElement).toBe(dialog);
    expect(document.activeElement).not.toBe(opener);
    expect(dialog).toHaveAccessibleName('Edit seat');
  });

  it('holds the focus trap — Tab from mount lands on the first field inside the dialog', async () => {
    const user = userEvent.setup();
    render(<PrefilledHarness initialOpen autoFocusFirstField={false} />);
    const dialog = screen.getByRole('dialog');
    await user.tab();
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(screen.getByTestId('calling'));
  });

  it('pulls focus back when something outside the dialog takes it', async () => {
    // The trap's own mechanism, independent of Tab: FocusScope refocuses
    // its last in-scope element on a focusin from outside. That memo is
    // seeded by the open-focus, so a suppressed-and-not-redirected mount
    // would leave it null and let focus escape to the page behind.
    render(<PrefilledHarness initialOpen autoFocusFirstField={false} />);
    const dialog = screen.getByRole('dialog');
    const outside = screen.getByTestId('outside') as HTMLButtonElement;
    outside.focus();
    expect(document.activeElement).not.toBe(outside);
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it('closes on Escape from mount with no prior click', async () => {
    const user = userEvent.setup();
    render(<PrefilledHarness initialOpen autoFocusFirstField={false} />);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('leaves focus on close exactly where the default dialog leaves it', async () => {
    // The opt-out changes mount focus only. Radix's close-focus path is
    // `onCloseAutoFocus`, which we never touch, so dismissing must land
    // focus in the same place either way. Asserted as a differential
    // rather than against a fixed element on purpose: this app drives
    // every Dialog from a controlled `open` prop instead of
    // `Dialog.Trigger`, so Radix's `triggerRef` is null and its close
    // handler restores focus to nothing — both paths land on <body>.
    // Pinning the difference is what's in scope here; the shared gap is
    // pre-existing and identical for all dialogs.
    async function closeAndReportActive(autoFocusFirstField?: boolean) {
      const user = userEvent.setup();
      const view = render(
        <PrefilledHarness
          {...(autoFocusFirstField === undefined ? {} : { autoFocusFirstField })}
        />,
      );
      await user.click(screen.getByRole('button', { name: /^Open$/ }));
      await user.keyboard('{Escape}');
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      const active = document.activeElement;
      view.unmount();
      return active === document.body ? 'body' : (active?.tagName ?? 'none');
    }
    const withDefault = await closeAndReportActive(undefined);
    const withOptOut = await closeAndReportActive(false);
    expect(withOptOut).toBe(withDefault);
  });
});
