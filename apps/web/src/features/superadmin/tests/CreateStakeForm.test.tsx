// Component tests for the Create Stake form (spec §5.4). Mocks the
// `useCreateStake` mutation hook at the module boundary so the test
// exercises validation, error surfacing, slug preview, and the
// success-side close / toast contract without standing up Firestore
// or the Functions emulator.
//
// As of the modal flip the form lives inside a Dialog; tests drive it
// via a small controlled harness so we exercise the open/close lifecycle
// (open transition resets the form; successful submit calls `onClose`).
//
// Coverage target:
//   - Fields render with sensible defaults (timezone defaulted via the
//     shared TimezoneCombobox).
//   - Empty `stake_name` is rejected client-side by the zod resolver.
//   - Empty `bootstrap_admin_email` is rejected client-side.
//   - Valid submit invokes the mutation with the expected payload.
//   - Picking a different timezone from the combobox propagates into
//     the submitted payload.
//   - Each soft-fail error code (`name_required`, `email_required`,
//     `invalid_email`, `slug_collision`, `invalid_slug`,
//     `invalid_timezone`) surfaces as an inline message against the
//     matching field.
//   - `{success:true}` fires a success toast + calls `onClose`. The
//     new stake row arrives via the live `useStakes()` snapshot
//     listener; `useCreateStake` has no `onSuccess` (`invalidateQueries`
//     is a no-op against the D11 never-resolving `queryFn`).
//   - Re-opening the dialog after a successful create yields an empty
//     form (open-transition `reset()`).
//   - Cancel button calls `onClose` without firing the mutation.
//   - Hard errors (thrown HttpsError) surface as a toast.
//   - Slug preview tracks the typed name in real time.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { CreateStakeInput, CreateStakeResult } from '@kindoo/shared';

const mutateAsyncMock = vi.fn<(input: CreateStakeInput) => Promise<CreateStakeResult>>();
const toastMock = vi.fn();

vi.mock('../hooks', () => ({
  useCreateStake: () => ({
    mutateAsync: mutateAsyncMock,
    isPending: false,
  }),
}));

vi.mock('../../../lib/store/toast', () => ({
  toast: (...args: unknown[]) => toastMock(...args),
}));

import { CreateStakeForm } from '../CreateStakeForm';
import { DEFAULT_TIMEZONE } from '../schemas';

beforeEach(() => {
  mutateAsyncMock.mockReset();
  toastMock.mockReset();
});

/**
 * Harness that mirrors how `StakeListPage` drives the modal: a trigger
 * button flips `open` true, the dialog calls `onClose` to flip it back.
 * Exposes the trigger so tests that need an open-close-open cycle can
 * re-open the dialog. `onClose` is forwarded to a spy so tests can
 * assert that successful submits / Cancel clicks close the modal.
 */
function Harness({
  initialOpen = true,
  onClose = () => {},
}: {
  initialOpen?: boolean;
  onClose?: () => void;
}) {
  const [open, setOpen] = useState(initialOpen);
  return (
    <>
      <button type="button" data-testid="harness-open" onClick={() => setOpen(true)}>
        Open
      </button>
      <CreateStakeForm
        open={open}
        onClose={() => {
          setOpen(false);
          onClose();
        }}
      />
    </>
  );
}

describe('<CreateStakeForm />', () => {
  it('renders all three fields with the timezone defaulted to America/Denver', () => {
    render(<Harness />);
    const name = screen.getByTestId('create-stake-name') as HTMLInputElement;
    const email = screen.getByTestId('create-stake-email') as HTMLInputElement;
    const tz = screen.getByTestId('create-stake-timezone');
    expect(name.value).toBe('');
    expect(email.value).toBe('');
    // The combobox trigger is a button; assert the rendered IANA label
    // rather than a non-existent `.value`.
    expect(tz).toHaveTextContent(DEFAULT_TIMEZONE);
  });

  it('renders a hint under the bootstrap email explaining the lowercase normalization', () => {
    // Backend lowercases the stored bootstrap_admin_email server-side
    // so it matches what Google sign-in normalizes addresses to. The
    // hint exists so the operator isn't surprised when their input
    // changes case on save.
    render(<Harness />);
    expect(screen.getByTestId('create-stake-email-hint')).toHaveTextContent(/lowercased/i);
  });

  it('does not render the form when closed', () => {
    render(<Harness initialOpen={false} />);
    expect(screen.queryByTestId('create-stake-form')).toBeNull();
  });

  it('blocks submit when stake_name is empty (zod resolver)', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(screen.getByTestId('create-stake-email'), 'admin@example.com');
    await user.click(screen.getByTestId('create-stake-submit'));
    expect(await screen.findByTestId('create-stake-name-error')).toHaveTextContent(
      /Stake name is required/i,
    );
    expect(mutateAsyncMock).not.toHaveBeenCalled();
  });

  it('blocks submit when bootstrap_admin_email is empty (zod resolver)', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(screen.getByTestId('create-stake-name'), 'Cottonwood South Stake');
    await user.click(screen.getByTestId('create-stake-submit'));
    expect(await screen.findByTestId('create-stake-email-error')).toHaveTextContent(
      /Bootstrap admin email is required/i,
    );
    expect(mutateAsyncMock).not.toHaveBeenCalled();
  });

  it('blocks submit when bootstrap_admin_email is malformed', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(screen.getByTestId('create-stake-name'), 'Cottonwood South Stake');
    await user.type(screen.getByTestId('create-stake-email'), 'not-an-email');
    await user.click(screen.getByTestId('create-stake-submit'));
    expect(await screen.findByTestId('create-stake-email-error')).toHaveTextContent(/valid email/i);
    expect(mutateAsyncMock).not.toHaveBeenCalled();
  });

  it('updates the slug preview as the user types the stake name', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(screen.getByTestId('create-stake-name'), 'Cottonwood South Stake');
    const preview = screen.getByTestId('create-stake-slug-preview');
    expect(preview).toHaveTextContent(/cottonwood-south-stake/);
  });

  it('collapses runs of non-alphanumeric characters in the slug preview', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(screen.getByTestId('create-stake-name'), "St. Mary's --- Stake!");
    const preview = screen.getByTestId('create-stake-slug-preview');
    expect(preview).toHaveTextContent(/st-mary-s-stake/);
  });

  it('calls the createStake mutation with the typed payload on valid submit', async () => {
    mutateAsyncMock.mockResolvedValue({ success: true, stakeId: 'cottonwood-south-stake' });
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(screen.getByTestId('create-stake-name'), 'Cottonwood South Stake');
    await user.type(screen.getByTestId('create-stake-email'), 'admin@example.com');
    await user.click(screen.getByTestId('create-stake-submit'));

    expect(mutateAsyncMock).toHaveBeenCalledTimes(1);
    expect(mutateAsyncMock).toHaveBeenCalledWith({
      stake_name: 'Cottonwood South Stake',
      bootstrap_admin_email: 'admin@example.com',
      timezone: DEFAULT_TIMEZONE,
    });
  });

  it('propagates a timezone change picked from the combobox into the payload', async () => {
    mutateAsyncMock.mockResolvedValue({ success: true, stakeId: 'cottonwood-south-stake' });
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(screen.getByTestId('create-stake-name'), 'Cottonwood South Stake');
    await user.type(screen.getByTestId('create-stake-email'), 'admin@example.com');
    // Open the combobox, pick a non-default zone, then submit.
    await user.click(screen.getByTestId('create-stake-timezone'));
    await user.click(await screen.findByTestId('create-stake-timezone-option-America/Chicago'));
    await user.click(screen.getByTestId('create-stake-submit'));

    expect(mutateAsyncMock).toHaveBeenCalledWith({
      stake_name: 'Cottonwood South Stake',
      bootstrap_admin_email: 'admin@example.com',
      timezone: 'America/Chicago',
    });
  });

  it('fires a success toast and closes the dialog on {success:true}', async () => {
    mutateAsyncMock.mockResolvedValue({ success: true, stakeId: 'cottonwood-south-stake' });
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<Harness onClose={onClose} />);
    await user.type(screen.getByTestId('create-stake-name'), 'Cottonwood South Stake');
    await user.type(screen.getByTestId('create-stake-email'), 'admin@example.com');
    await user.click(screen.getByTestId('create-stake-submit'));

    // Wait for the dialog content to leave the DOM (close-on-success).
    await vi.waitFor(() => {
      expect(screen.queryByTestId('create-stake-form')).toBeNull();
    });
    expect(toastMock).toHaveBeenCalledWith('Stake `cottonwood-south-stake` created.', 'success');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('clears the form on re-open after a successful create', async () => {
    mutateAsyncMock.mockResolvedValue({ success: true, stakeId: 'cottonwood-south-stake' });
    const user = userEvent.setup();
    render(<Harness />);
    // First open: type values, switch tz, submit -> dialog closes.
    await user.type(screen.getByTestId('create-stake-name'), 'Cottonwood South Stake');
    await user.type(screen.getByTestId('create-stake-email'), 'admin@example.com');
    await user.click(screen.getByTestId('create-stake-timezone'));
    await user.click(await screen.findByTestId('create-stake-timezone-option-America/Chicago'));
    await user.click(screen.getByTestId('create-stake-submit'));
    await vi.waitFor(() => {
      expect(screen.queryByTestId('create-stake-form')).toBeNull();
    });

    // Re-open via the harness trigger: every field should be empty,
    // tz back to default.
    await user.click(screen.getByTestId('harness-open'));
    expect((await screen.findByTestId('create-stake-name')) as HTMLInputElement).toHaveValue('');
    expect(screen.getByTestId('create-stake-email')).toHaveValue('');
    expect(screen.getByTestId('create-stake-timezone')).toHaveTextContent(DEFAULT_TIMEZONE);
  });

  it('calls onClose when the Cancel button is clicked, without firing the mutation', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<Harness onClose={onClose} />);
    await user.type(screen.getByTestId('create-stake-name'), 'Cottonwood South Stake');
    await user.click(screen.getByTestId('create-stake-cancel'));

    await vi.waitFor(() => {
      expect(screen.queryByTestId('create-stake-form')).toBeNull();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mutateAsyncMock).not.toHaveBeenCalled();
  });

  it('closes the dialog when Escape is pressed', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<Harness onClose={onClose} />);
    await user.keyboard('{Escape}');
    await vi.waitFor(() => {
      expect(screen.queryByTestId('create-stake-form')).toBeNull();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('surfaces `name_required` against the stake_name field', async () => {
    mutateAsyncMock.mockResolvedValue({ success: false, error: 'name_required' });
    const user = userEvent.setup();
    render(<Harness />);
    // Bypass the client-side zod check by typing whitespace that
    // survives `.trim().min(1)` on the email side but flips the
    // server-side guard on the name. Simpler: type a single character
    // so zod passes, then force the mock to return the soft-fail.
    await user.type(screen.getByTestId('create-stake-name'), 'X');
    await user.type(screen.getByTestId('create-stake-email'), 'admin@example.com');
    await user.click(screen.getByTestId('create-stake-submit'));

    expect(await screen.findByTestId('create-stake-name-error')).toHaveTextContent(
      /Stake name is required/i,
    );
    expect(toastMock).not.toHaveBeenCalled();
  });

  it('surfaces `email_required` against the bootstrap_admin_email field', async () => {
    mutateAsyncMock.mockResolvedValue({ success: false, error: 'email_required' });
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(screen.getByTestId('create-stake-name'), 'Cottonwood South Stake');
    await user.type(screen.getByTestId('create-stake-email'), 'admin@example.com');
    await user.click(screen.getByTestId('create-stake-submit'));

    expect(await screen.findByTestId('create-stake-email-error')).toHaveTextContent(
      /Bootstrap admin email is required/i,
    );
    expect(toastMock).not.toHaveBeenCalled();
  });

  it('surfaces `invalid_email` against the bootstrap_admin_email field', async () => {
    // The form's zod resolver already blocks malformed addresses
    // client-side; this exists as defense-in-depth for the server's
    // own shape check (non-SDK callers / future zod-schema drift).
    mutateAsyncMock.mockResolvedValue({
      success: false,
      error: 'invalid_email',
    } as unknown as CreateStakeResult);
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(screen.getByTestId('create-stake-name'), 'Cottonwood South Stake');
    await user.type(screen.getByTestId('create-stake-email'), 'admin@example.com');
    await user.click(screen.getByTestId('create-stake-submit'));

    expect(await screen.findByTestId('create-stake-email-error')).toHaveTextContent(
      /not a valid email/i,
    );
    expect(toastMock).not.toHaveBeenCalled();
  });

  it('surfaces `invalid_slug` against the stake_name field', async () => {
    mutateAsyncMock.mockResolvedValue({ success: false, error: 'invalid_slug' });
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(screen.getByTestId('create-stake-name'), '###');
    await user.type(screen.getByTestId('create-stake-email'), 'admin@example.com');
    await user.click(screen.getByTestId('create-stake-submit'));

    expect(await screen.findByTestId('create-stake-name-error')).toHaveTextContent(
      /no letters or digits/i,
    );
    expect(toastMock).not.toHaveBeenCalled();
  });

  it('surfaces `slug_collision` against the stake_name field', async () => {
    mutateAsyncMock.mockResolvedValue({ success: false, error: 'slug_collision' });
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(screen.getByTestId('create-stake-name'), 'CS North Stake');
    await user.type(screen.getByTestId('create-stake-email'), 'admin@example.com');
    await user.click(screen.getByTestId('create-stake-submit'));

    expect(await screen.findByTestId('create-stake-name-error')).toHaveTextContent(
      /A stake with that slug already exists/i,
    );
    expect(toastMock).not.toHaveBeenCalled();
  });

  it('surfaces `invalid_timezone` against the timezone field', async () => {
    // The combobox restricts the picker to known-good IANA values, so
    // this code is unreachable from the UI in practice — kept as a
    // defense-in-depth assertion that the form-error mapping still
    // surfaces correctly if a non-SDK caller (or a server-side change)
    // produces it.
    mutateAsyncMock.mockResolvedValue({ success: false, error: 'invalid_timezone' });
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(screen.getByTestId('create-stake-name'), 'Cottonwood South Stake');
    await user.type(screen.getByTestId('create-stake-email'), 'admin@example.com');
    await user.click(screen.getByTestId('create-stake-submit'));

    expect(await screen.findByTestId('create-stake-timezone-error')).toHaveTextContent(
      /not a recognized IANA identifier/i,
    );
    expect(toastMock).not.toHaveBeenCalled();
  });

  it('fires an error toast when the callable throws a hard error', async () => {
    mutateAsyncMock.mockRejectedValue(new Error('internal: kaboom'));
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(screen.getByTestId('create-stake-name'), 'Cottonwood South Stake');
    await user.type(screen.getByTestId('create-stake-email'), 'admin@example.com');
    await user.click(screen.getByTestId('create-stake-submit'));

    // Wait for the catch path to fire the toast. The dialog stays open
    // on hard error so the form's still mounted.
    await screen.findByTestId('create-stake-form');
    expect(toastMock).toHaveBeenCalledWith('internal: kaboom', 'error');
  });
});
