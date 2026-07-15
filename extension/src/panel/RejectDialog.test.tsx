// Unit tests for the RejectDialog in isolation. Mocks the `rejectRequest`
// SW wrapper (`lib/extensionApi`) and asserts the component's own contract
// directly — independent of RequestCard's wiring:
//
//   - success → `onRejected` fires (parent drops the card + refetches),
//     `onCancel` does not, and the trimmed reason reaches the SW.
//   - FAILURE (rejectRequest throws) → the dialog stays rendered, the
//     `sba-reject-error-*` alert shows the message, NEITHER `onRejected`
//     nor `onCancel` fires (so the card is never dropped and the queue is
//     never refetched), and confirm re-enables for a retry. A subsequent
//     successful retry then fires `onRejected` — proving the dialog stayed
//     interactive and the success path still closes after a failure.
//   - cancel → `onCancel` fires without ever calling the SW.
//
// This is the regression guard for the operator-reported "failed reject
// flashed an error then the dialog closed" symptom: the failure path must
// never invoke `onRejected` (the sole close + dismiss trigger).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const rejectRequestMock = vi.fn();

vi.mock('../lib/extensionApi', async () => {
  const actual = await vi.importActual<typeof import('../lib/extensionApi')>('../lib/extensionApi');
  return {
    ...actual,
    rejectRequest: (...args: unknown[]) => rejectRequestMock(...args),
  };
});

import type { AccessRequest, Ward } from '@kindoo/shared';
import { RejectDialog } from './RejectDialog';

/** Minimal request fixture — only the fields RejectDialog reads. */
function request(overrides: Partial<AccessRequest> = {}): AccessRequest {
  return {
    request_id: 'r1',
    type: 'add_manual',
    scope: 'stake',
    member_email: 'member@example.com',
    member_canonical: 'member@example.com',
    member_name: 'Test User',
    ...overrides,
  } as AccessRequest;
}

const NO_WARDS: readonly Ward[] = [];

function renderDialog(
  opts: { onCancel?: () => void; onRejected?: () => void; request?: AccessRequest } = {},
) {
  const onCancel = opts.onCancel ?? vi.fn();
  const onRejected = opts.onRejected ?? vi.fn();
  render(
    <RejectDialog
      stakeId="csnorth"
      request={opts.request ?? request()}
      wards={NO_WARDS}
      onCancel={onCancel}
      onRejected={onRejected}
    />,
  );
  return { onCancel, onRejected };
}

describe('RejectDialog', () => {
  beforeEach(() => {
    rejectRequestMock.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps confirm disabled until a non-whitespace reason is typed', async () => {
    const user = userEvent.setup();
    renderDialog();

    expect(screen.getByTestId('sba-reject-confirm-r1')).toBeDisabled();
    await user.type(screen.getByTestId('sba-reject-reason-r1'), '   ');
    expect(screen.getByTestId('sba-reject-confirm-r1')).toBeDisabled();
    await user.type(screen.getByTestId('sba-reject-reason-r1'), 'Duplicate');
    expect(screen.getByTestId('sba-reject-confirm-r1')).toBeEnabled();
  });

  it('rejects with the trimmed reason and calls onRejected (not onCancel) on success', async () => {
    rejectRequestMock.mockResolvedValue(undefined);
    const user = userEvent.setup();
    const { onCancel, onRejected } = renderDialog();

    await user.type(screen.getByTestId('sba-reject-reason-r1'), '  Not eligible  ');
    await user.click(screen.getByTestId('sba-reject-confirm-r1'));

    await waitFor(() => expect(onRejected).toHaveBeenCalledTimes(1));
    expect(rejectRequestMock).toHaveBeenCalledWith('csnorth', 'r1', 'Not eligible');
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('on a FAILED reject: shows the error, stays open, and fires neither onRejected nor onCancel', async () => {
    // Silence the grep-able console.error the catch block emits.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    rejectRequestMock.mockRejectedValue(
      new Error('Request is no longer pending (current status: complete).'),
    );
    const user = userEvent.setup();
    const { onCancel, onRejected } = renderDialog();

    await user.type(screen.getByTestId('sba-reject-reason-r1'), 'Duplicate');
    await user.click(screen.getByTestId('sba-reject-confirm-r1'));

    // Error surfaces in the alert.
    await waitFor(() =>
      expect(screen.getByTestId('sba-reject-error-r1')).toHaveTextContent(/no longer pending/),
    );
    // Dialog is still mounted — nothing tore it down.
    expect(screen.getByTestId('sba-reject-dialog-r1')).toBeInTheDocument();
    // The two close/dismiss triggers NEVER fired on the failure path.
    expect(onRejected).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
    // Confirm re-enables so the operator can retry.
    expect(screen.getByTestId('sba-reject-confirm-r1')).toBeEnabled();
  });

  it('allows a successful retry after a failure — the dialog stayed interactive', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    rejectRequestMock
      .mockRejectedValueOnce(new Error('Transient SW failure'))
      .mockResolvedValueOnce(undefined);
    const user = userEvent.setup();
    const { onRejected } = renderDialog();

    await user.type(screen.getByTestId('sba-reject-reason-r1'), 'Duplicate');
    await user.click(screen.getByTestId('sba-reject-confirm-r1'));

    await waitFor(() =>
      expect(screen.getByTestId('sba-reject-error-r1')).toHaveTextContent(/Transient SW failure/),
    );
    expect(onRejected).not.toHaveBeenCalled();

    // Retry on the same open dialog now succeeds → onRejected fires and the
    // stale error clears before the (successful) call.
    await user.click(screen.getByTestId('sba-reject-confirm-r1'));
    await waitFor(() => expect(onRejected).toHaveBeenCalledTimes(1));
    expect(rejectRequestMock).toHaveBeenCalledTimes(2);
  });

  it('cancel calls onCancel without ever calling the SW', async () => {
    const user = userEvent.setup();
    const { onCancel, onRejected } = renderDialog();

    await user.click(screen.getByTestId('sba-reject-cancel-r1'));

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onRejected).not.toHaveBeenCalled();
    expect(rejectRequestMock).not.toHaveBeenCalled();
  });
});
