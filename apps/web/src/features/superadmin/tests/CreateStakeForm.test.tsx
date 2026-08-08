// Component tests for the Create Stake form (spec §5.4). Mocks the
// `useCreateStake` mutation hook at the module boundary so the test
// exercises validation, error surfacing, the Stake ID field's
// autofill/detach behaviour, and the success-side close / toast
// contract without standing up Firestore or the Functions emulator.
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
//   - Stake ID follows the stake name until the operator edits it,
//     detaches on edit so later name edits leave it alone, and
//     re-attaches when cleared back to empty.
//   - The Stake ID field can only hold a canonical slug: direct input
//     is sanitized on every keystroke, with a trailing hyphen kept
//     mid-typing (so `cs ` doesn't collapse and eat the boundary) and
//     trimmed by submit.
//   - Picking a different timezone from the combobox propagates into
//     the submitted payload.
//   - Each soft-fail error code (`name_required`, `email_required`,
//     `invalid_email`, `slug_collision`, `invalid_slug`,
//     `invalid_timezone`) surfaces as an inline message against the
//     matching field — the slug codes landing on Stake ID when the
//     payload carried one and on the name when it didn't.
//   - A server error on Stake ID clears once the operator edits the
//     field, the same way a normally registered field's would — and on
//     the other route out of a collision, renaming the stake while the
//     ID still follows the name.
//   - A mid-string edit that rewrites the value keeps the caret where
//     the operator was typing.
//   - `{success:true}` fires a success toast + calls `onClose`. The
//     new stake row arrives via the live `useStakes()` snapshot
//     listener; `useCreateStake` has no `onSuccess` (`invalidateQueries`
//     is a no-op against the D11 never-resolving `queryFn`). No forced
//     token refresh — `createStake` is superadmin-gated, so the creator
//     already holds the claim needed to see the new stake via its
//     deep-link; the StakeSwitcher entry lands on the next natural
//     token refresh.
//   - Re-opening the dialog after a successful create yields an empty
//     form and a re-attached Stake ID (open-transition `reset()`).
//   - Cancel button calls `onClose` without firing the mutation.
//   - Hard errors (thrown HttpsError) surface as a toast.

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
  it('renders all four fields with an empty stake ID and the timezone defaulted to America/Denver', () => {
    render(<Harness />);
    const name = screen.getByTestId('create-stake-name') as HTMLInputElement;
    const stakeId = screen.getByTestId('create-stake-id') as HTMLInputElement;
    const email = screen.getByTestId('create-stake-email') as HTMLInputElement;
    const tz = screen.getByTestId('create-stake-timezone');
    expect(name.value).toBe('');
    expect(stakeId.value).toBe('');
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

  it('fills the stake ID with the slugified name as the user types the stake name', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(screen.getByTestId('create-stake-name'), 'Cedar Springs North');
    expect(screen.getByTestId('create-stake-id')).toHaveValue('cedar-springs-north');
  });

  it('collapses runs of non-alphanumeric characters when filling from the name', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(screen.getByTestId('create-stake-name'), "St. Mary's --- Stake!");
    expect(screen.getByTestId('create-stake-id')).toHaveValue('st-mary-s-stake');
  });

  it('renders a hint under the stake ID covering the format and the default', async () => {
    render(<Harness />);
    const hint = screen.getByTestId('create-stake-id-hint');
    expect(hint).toHaveTextContent(/lowercase letters, digits, and hyphens/i);
    expect(hint).toHaveTextContent(/defaults from the stake name/i);
  });

  it('detaches the stake ID from the name once the operator edits it', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(screen.getByTestId('create-stake-name'), 'Cedar Springs');
    expect(screen.getByTestId('create-stake-id')).toHaveValue('cedar-springs');

    // Taking the field over stops the name from driving it.
    await user.clear(screen.getByTestId('create-stake-id'));
    await user.type(screen.getByTestId('create-stake-id'), 'my-own-id');
    await user.type(screen.getByTestId('create-stake-name'), ' North');

    expect(screen.getByTestId('create-stake-name')).toHaveValue('Cedar Springs North');
    expect(screen.getByTestId('create-stake-id')).toHaveValue('my-own-id');
  });

  it('re-attaches to the name when the stake ID is cleared back to empty', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(screen.getByTestId('create-stake-name'), 'Cottonwood South Stake');
    await user.clear(screen.getByTestId('create-stake-id'));
    await user.type(screen.getByTestId('create-stake-id'), 'my-own-id');

    // Clearing is the operator asking for the default back, so the name
    // drives the field again from here on.
    await user.clear(screen.getByTestId('create-stake-id'));
    await user.type(screen.getByTestId('create-stake-name'), ' Two');
    expect(screen.getByTestId('create-stake-id')).toHaveValue('cottonwood-south-stake-two');
  });

  it('stays empty while the operator types a fresh ID rather than appending to the default', async () => {
    // Refilling the instant the field empties would turn "clear it and
    // type my own" into `cottonwood-south-stakecs-north`.
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(screen.getByTestId('create-stake-name'), 'Cottonwood South Stake');
    await user.clear(screen.getByTestId('create-stake-id'));
    expect(screen.getByTestId('create-stake-id')).toHaveValue('');

    await user.type(screen.getByTestId('create-stake-id'), 'cs-north');
    expect(screen.getByTestId('create-stake-id')).toHaveValue('cs-north');
  });

  it('restores the name-derived default when an emptied stake ID field loses focus', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(screen.getByTestId('create-stake-name'), 'Cottonwood South Stake');
    await user.clear(screen.getByTestId('create-stake-id'));
    await user.click(screen.getByTestId('create-stake-email'));
    expect(screen.getByTestId('create-stake-id')).toHaveValue('cottonwood-south-stake');
  });

  it('sanitizes direct typing in the stake ID field: `CS North` becomes `cs-north`', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(screen.getByTestId('create-stake-id'), 'CS North');
    expect(screen.getByTestId('create-stake-id')).toHaveValue('cs-north');
  });

  it('replaces punctuation runs with a single hyphen while typing in the stake ID field', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(screen.getByTestId('create-stake-id'), "St. Mary's --- Stake!");
    expect(screen.getByTestId('create-stake-id')).toHaveValue('st-mary-s-stake-');
  });

  it('keeps a trailing hyphen mid-typing but drops it by submit', async () => {
    // Collapsing `cs ` to `cs` would make the next character produce
    // `csnorth`; the hyphen has to survive input and die on the way out.
    mutateAsyncMock.mockResolvedValue({ success: true, stakeId: 'cs' });
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(screen.getByTestId('create-stake-name'), 'Cottonwood South Stake');
    await user.clear(screen.getByTestId('create-stake-id'));
    await user.type(screen.getByTestId('create-stake-id'), 'cs ');
    expect(screen.getByTestId('create-stake-id')).toHaveValue('cs-');

    await user.type(screen.getByTestId('create-stake-email'), 'admin@example.com');
    await user.click(screen.getByTestId('create-stake-submit'));

    expect(mutateAsyncMock.mock.calls[0]?.[0]?.stake_id).toBe('cs');
  });

  it('trims the trailing hyphen on a submit that beats the blur', async () => {
    // Enter submits straight from the focused field, so the blur-time
    // trim never runs and the submit handler has to do it.
    mutateAsyncMock.mockResolvedValue({ success: true, stakeId: 'cs' });
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(screen.getByTestId('create-stake-name'), 'Cottonwood South Stake');
    await user.type(screen.getByTestId('create-stake-email'), 'admin@example.com');
    await user.clear(screen.getByTestId('create-stake-id'));
    await user.type(screen.getByTestId('create-stake-id'), 'cs {enter}');

    await vi.waitFor(() => {
      expect(mutateAsyncMock).toHaveBeenCalledTimes(1);
    });
    expect(mutateAsyncMock.mock.calls[0]?.[0]?.stake_id).toBe('cs');
  });

  it('trims the trailing hyphen when the stake ID field loses focus', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(screen.getByTestId('create-stake-id'), 'cs ');
    expect(screen.getByTestId('create-stake-id')).toHaveValue('cs-');
    await user.click(screen.getByTestId('create-stake-email'));
    expect(screen.getByTestId('create-stake-id')).toHaveValue('cs');
  });

  it('calls the createStake mutation with the typed payload on valid submit', async () => {
    mutateAsyncMock.mockResolvedValue({ success: true, stakeId: 'cottonwood-south-stake' });
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(screen.getByTestId('create-stake-name'), 'Cottonwood South Stake');
    await user.type(screen.getByTestId('create-stake-email'), 'admin@example.com');
    await user.click(screen.getByTestId('create-stake-submit'));

    expect(mutateAsyncMock).toHaveBeenCalledTimes(1);
    // The autofilled ID rides along. It's the same slug the callable
    // would derive from the name on its own, so the outcome is
    // unchanged — but the operator saw it before submitting.
    expect(mutateAsyncMock).toHaveBeenCalledWith({
      stake_name: 'Cottonwood South Stake',
      stake_id: 'cottonwood-south-stake',
      bootstrap_admin_email: 'admin@example.com',
      timezone: DEFAULT_TIMEZONE,
    });
  });

  it('sends an operator-edited stake ID in the payload instead of the name-derived one', async () => {
    mutateAsyncMock.mockResolvedValue({ success: true, stakeId: 'cs-north' });
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(screen.getByTestId('create-stake-name'), 'Cottonwood South Stake');
    await user.clear(screen.getByTestId('create-stake-id'));
    await user.type(screen.getByTestId('create-stake-id'), 'cs-north');
    await user.type(screen.getByTestId('create-stake-email'), 'admin@example.com');
    await user.click(screen.getByTestId('create-stake-submit'));

    expect(mutateAsyncMock).toHaveBeenCalledWith({
      stake_name: 'Cottonwood South Stake',
      stake_id: 'cs-north',
      bootstrap_admin_email: 'admin@example.com',
      timezone: DEFAULT_TIMEZONE,
    });
  });

  it('omits stake_id from the payload entirely when the field is empty', async () => {
    // The callable treats an absent key as "derive from the name"; an
    // empty string would be a different (and wrong) instruction. With
    // autofill the field is only empty when the name has nothing to
    // slugify, which is the case this reaches.
    mutateAsyncMock.mockResolvedValue({ success: false, error: 'invalid_slug' });
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(screen.getByTestId('create-stake-name'), '###');
    await user.type(screen.getByTestId('create-stake-email'), 'admin@example.com');
    expect(screen.getByTestId('create-stake-id')).toHaveValue('');
    await user.click(screen.getByTestId('create-stake-submit'));

    const payload = mutateAsyncMock.mock.calls[0]?.[0];
    expect(payload).toBeDefined();
    expect(Object.keys(payload as object)).not.toContain('stake_id');
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
      stake_id: 'cottonwood-south-stake',
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

  it('clears the form and re-attaches the stake ID on re-open after a successful create', async () => {
    mutateAsyncMock.mockResolvedValue({ success: true, stakeId: 'cw-south' });
    const user = userEvent.setup();
    render(<Harness />);
    // First open: type values, take the stake ID over, switch tz,
    // submit -> dialog closes.
    await user.type(screen.getByTestId('create-stake-name'), 'Cottonwood South Stake');
    await user.clear(screen.getByTestId('create-stake-id'));
    await user.type(screen.getByTestId('create-stake-id'), 'cw-south');
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
    expect(screen.getByTestId('create-stake-id')).toHaveValue('');
    expect(screen.getByTestId('create-stake-email')).toHaveValue('');
    expect(screen.getByTestId('create-stake-timezone')).toHaveTextContent(DEFAULT_TIMEZONE);

    // The detach flag is form state too: the fresh dialog's stake ID
    // follows the name again rather than staying stuck from last time.
    await user.type(screen.getByTestId('create-stake-name'), 'Cedar Springs');
    expect(screen.getByTestId('create-stake-id')).toHaveValue('cedar-springs');
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

  it('surfaces `invalid_slug` against the stake_name field when the payload carried no stake ID', async () => {
    // A name with nothing to slugify leaves the autofilled ID empty, so
    // the name is the field the operator has to fix.
    mutateAsyncMock.mockResolvedValue({ success: false, error: 'invalid_slug' });
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(screen.getByTestId('create-stake-name'), '###');
    await user.type(screen.getByTestId('create-stake-email'), 'admin@example.com');
    await user.click(screen.getByTestId('create-stake-submit'));

    expect(await screen.findByTestId('create-stake-name-error')).toHaveTextContent(
      /no letters or digits/i,
    );
    expect(screen.queryByTestId('create-stake-id-error')).toBeNull();
    expect(toastMock).not.toHaveBeenCalled();
  });

  it('surfaces `invalid_slug` against the stake ID field when the payload carried one', async () => {
    mutateAsyncMock.mockResolvedValue({ success: false, error: 'invalid_slug' });
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(screen.getByTestId('create-stake-name'), 'Cottonwood South Stake');
    await user.type(screen.getByTestId('create-stake-email'), 'admin@example.com');
    await user.click(screen.getByTestId('create-stake-submit'));

    expect(await screen.findByTestId('create-stake-id-error')).toHaveTextContent(
      /no letters or digits/i,
    );
    expect(screen.queryByTestId('create-stake-name-error')).toBeNull();
    expect(toastMock).not.toHaveBeenCalled();
  });

  it('surfaces `slug_collision` against the stake ID field, which is the field that owns the slug', async () => {
    mutateAsyncMock.mockResolvedValue({ success: false, error: 'slug_collision' });
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(screen.getByTestId('create-stake-name'), 'CS North Stake');
    await user.clear(screen.getByTestId('create-stake-id'));
    await user.type(screen.getByTestId('create-stake-id'), 'cs-north');
    await user.type(screen.getByTestId('create-stake-email'), 'admin@example.com');
    await user.click(screen.getByTestId('create-stake-submit'));

    // A collision is fixed by picking a different ID, not by renaming
    // the stake — and the ID is right there, editable.
    expect(await screen.findByTestId('create-stake-id-error')).toHaveTextContent(
      /A stake with that ID already exists\. Pick a different ID/i,
    );
    expect(screen.queryByTestId('create-stake-name-error')).toBeNull();
    expect(toastMock).not.toHaveBeenCalled();
  });

  it('clears a server error on the stake ID as soon as the operator edits the field', async () => {
    // The registered `onChange` is replaced by the sanitize handler, so
    // RHF's post-submit re-validation only runs if that handler asks for
    // it. Without it the collision message from the last submit sits
    // there while the operator types a completely different ID.
    mutateAsyncMock.mockResolvedValue({ success: false, error: 'slug_collision' });
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(screen.getByTestId('create-stake-name'), 'CS North Stake');
    await user.type(screen.getByTestId('create-stake-email'), 'admin@example.com');
    await user.click(screen.getByTestId('create-stake-submit'));
    await screen.findByTestId('create-stake-id-error');

    await user.clear(screen.getByTestId('create-stake-id'));
    await user.type(screen.getByTestId('create-stake-id'), 'cs-north-two');
    await vi.waitFor(() => {
      expect(screen.queryByTestId('create-stake-id-error')).toBeNull();
    });

    // And it stays cleared through the blur-time trim/refill.
    await user.click(screen.getByTestId('create-stake-email'));
    expect(screen.getByTestId('create-stake-id')).toHaveValue('cs-north-two');
    expect(screen.queryByTestId('create-stake-id-error')).toBeNull();
  });

  it('clears a server error on the stake ID when the operator renames the stake instead', async () => {
    // Renaming is the other natural answer to a collision, and while the
    // ID still follows the name it changes underneath the operator when
    // they do — so the error has to clear on that path too.
    mutateAsyncMock.mockResolvedValue({ success: false, error: 'slug_collision' });
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(screen.getByTestId('create-stake-name'), 'CS North');
    await user.type(screen.getByTestId('create-stake-email'), 'admin@example.com');
    await user.click(screen.getByTestId('create-stake-submit'));
    await screen.findByTestId('create-stake-id-error');

    await user.type(screen.getByTestId('create-stake-name'), ' Two');
    expect(screen.getByTestId('create-stake-id')).toHaveValue('cs-north-two');
    await vi.waitFor(() => {
      expect(screen.queryByTestId('create-stake-id-error')).toBeNull();
    });
  });

  it('leaves the caret where the operator typed when a mid-string edit rewrites the value', async () => {
    // Typing a space inside `cs|north` yields `cs-north`; rewriting the
    // field value drops the caret to the end, so the handler puts it
    // back at 3 — otherwise the rest of the ID gets typed backwards.
    // A literal `-` wouldn't exercise this: the value is unchanged, and
    // neither jsdom nor a browser moves the caret then.
    const user = userEvent.setup();
    render(<Harness />);
    const stakeId = screen.getByTestId('create-stake-id') as HTMLInputElement;
    await user.type(stakeId, 'csnorth');
    await user.type(stakeId, ' ', {
      initialSelectionStart: 2,
      initialSelectionEnd: 2,
    });

    expect(stakeId).toHaveValue('cs-north');
    expect(stakeId.selectionStart).toBe(3);
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
