// Component tests for the Dialog primitive. Uses @testing-library/user-event
// to drive ESC key handling and focus assertions, both of which are
// the headline accessibility requirements per the migration plan.
//
// Radix Dialog handles focus-trap + ESC for us; these tests exist to
// (a) catch a future refactor that drops the Radix layer, and (b)
// document the expected behaviour for downstream pages.

import { describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { render, screen } from '@testing-library/react';
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
