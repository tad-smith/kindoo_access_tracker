// Component tests for the per-row Apply Fixes menu (spec §5.4). Mocks
// the `useApplyStakeFix` mutation at the hooks boundary so the flow runs
// without the Functions emulator: dropdown → Explain dialog → (mocked
// callable) → Result dialog, covering success render, error render, and
// the Copy action.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSyncExternalStore } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { TimestampLike } from '@kindoo/shared';
import type { StakeWithId } from '../hooks';

const mutateAsyncMock = vi.fn<(input: { callable: string; stakeId: string }) => Promise<unknown>>();
const resetMock = vi.fn();
const toastMock = vi.fn();

// `isPending` is a reactive value: the mock is a real hook backed by a
// tiny external store so flipping `pending` triggers a component
// re-render (mirroring TanStack's mutation behaviour). Most tests leave
// `pending` false; the in-flight tests flip it to exercise the
// dismissal-lock path.
let pending = false;
const pendingListeners = new Set<() => void>();
function setPending(next: boolean) {
  pending = next;
  for (const l of pendingListeners) l();
}

vi.mock('../hooks', () => ({
  useApplyStakeFix: () => {
    const isPending = useSyncExternalStore(
      (onChange) => {
        pendingListeners.add(onChange);
        return () => pendingListeners.delete(onChange);
      },
      () => pending,
    );
    return { mutateAsync: mutateAsyncMock, reset: resetMock, isPending };
  },
}));

vi.mock('../../../lib/store/toast', () => ({
  toast: (...args: unknown[]) => toastMock(...args),
}));

import { ApplyFixesMenu } from '../ApplyFixesMenu';

function ts(iso: string): TimestampLike {
  const d = new Date(iso);
  return {
    seconds: Math.floor(d.getTime() / 1000),
    nanoseconds: 0,
    toDate: () => d,
    toMillis: () => d.getTime(),
  };
}

function makeStake(overrides: Partial<StakeWithId> = {}): StakeWithId {
  const actor = { email: 'super@example.com', canonical: 'super@example.com' };
  const created = ts('2026-04-01T12:00:00Z');
  return {
    id: 'csnorth',
    stake_name: 'CS North Stake',
    created_at: created,
    created_by: 'super@example.com',
    bootstrap_admin_email: 'admin@csnorth.org',
    setup_complete: true,
    stake_seat_cap: 200,
    timezone: 'America/Denver',
    notifications_enabled: true,
    last_over_caps_json: [],
    last_modified_at: created,
    last_modified_by: actor,
    lastActor: actor,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  pending = false;
});

/** A promise plus its resolve/reject, for driving an in-flight mutation. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// jsdom defines `navigator.clipboard` as a getter-only property, so it
// can't be assigned directly — install a writeText spy via defineProperty.
function stubClipboard(): ReturnType<typeof vi.fn> {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
  });
  return writeText;
}

async function openExplain(user: ReturnType<typeof userEvent.setup>, stake: StakeWithId) {
  await user.selectOptions(
    screen.getByTestId(`apply-fixes-select-${stake.id}`),
    'backfill-kindoo-site-id',
  );
}

describe('<ApplyFixesMenu />', () => {
  it('lists the registered fixes as dropdown options scoped to the stake', () => {
    const stake = makeStake();
    render(<ApplyFixesMenu stake={stake} />);
    const select = screen.getByTestId(`apply-fixes-select-${stake.id}`);
    expect(select).toHaveAccessibleName(`Apply fix to ${stake.stake_name}`);
    expect(screen.getByRole('option', { name: 'Backfill Kindoo site IDs' })).toBeInTheDocument();
  });

  it('opens the Explain dialog naming the target stake when a fix is selected', async () => {
    const stake = makeStake({ stake_name: 'East Valley Stake' });
    render(<ApplyFixesMenu stake={stake} />);
    const user = userEvent.setup();
    await openExplain(user, stake);

    expect(screen.getByTestId('apply-fixes-explain')).toBeInTheDocument();
    expect(screen.getByTestId('apply-fixes-target')).toHaveTextContent('East Valley Stake');
    // Title = the fix label (the dialog heading, not the still-mounted
    // <option> of the same text).
    expect(screen.getByRole('heading', { name: 'Backfill Kindoo site IDs' })).toBeInTheDocument();
  });

  it('closes the Explain dialog without running the fix when Cancel is clicked', async () => {
    const stake = makeStake();
    render(<ApplyFixesMenu stake={stake} />);
    const user = userEvent.setup();
    await openExplain(user, stake);
    await user.click(screen.getByTestId('apply-fixes-cancel'));

    expect(screen.queryByTestId('apply-fixes-explain')).toBeNull();
    expect(mutateAsyncMock).not.toHaveBeenCalled();
  });

  it('invokes the fix callable with the stake id when Apply Fix is clicked', async () => {
    const stake = makeStake({ id: 'eaststake' });
    mutateAsyncMock.mockResolvedValueOnce({ ok: true, seats_total: 1, seats_updated: 0 });
    render(<ApplyFixesMenu stake={stake} />);
    const user = userEvent.setup();
    await openExplain(user, stake);
    await user.click(screen.getByTestId('apply-fixes-apply'));

    expect(mutateAsyncMock).toHaveBeenCalledWith({
      callable: 'backfillKindooSiteId',
      stakeId: 'eaststake',
    });
  });

  it('invokes the callable with the doc-id-derived stake id for a bootstrap stake', async () => {
    // `useStakes()` injects the doc id as `stake.id`, so even the
    // hand-seeded bootstrap stake (whose stored doc carries no id field)
    // arrives here with `id` set. The menu must pass that defined id
    // straight through — never `undefined`.
    const stake = makeStake({ id: 'csnorth', stake_name: 'CS North Stake' });
    mutateAsyncMock.mockResolvedValueOnce({ ok: true });
    render(<ApplyFixesMenu stake={stake} />);
    const user = userEvent.setup();
    await openExplain(user, stake);

    // The Explain dialog names the target stake (slug-backed row).
    expect(screen.getByTestId('apply-fixes-target')).toHaveTextContent('CS North Stake');

    await user.click(screen.getByTestId('apply-fixes-apply'));
    expect(mutateAsyncMock).toHaveBeenCalledWith({
      callable: 'backfillKindooSiteId',
      stakeId: 'csnorth',
    });
  });

  it('surfaces an error without invoking the callable when the stake id is missing', async () => {
    // Defense-in-depth: a malformed stake whose `id` is falsy must not
    // send `stakeId: undefined` to the callable (the server rejects it
    // with a cryptic `invalid-argument: stakeId required`). The Result
    // dialog shows a clear error instead.
    const stake = makeStake({ id: '' });
    render(<ApplyFixesMenu stake={stake} />);
    const user = userEvent.setup();
    await user.selectOptions(screen.getByTestId('apply-fixes-select-'), 'backfill-kindoo-site-id');
    await user.click(screen.getByTestId('apply-fixes-apply'));

    await waitFor(() => {
      expect(screen.getByTestId('apply-fixes-result-error')).toBeInTheDocument();
    });
    expect(screen.getByTestId('apply-fixes-error-message')).toHaveTextContent(/missing stake id/i);
    expect(mutateAsyncMock).not.toHaveBeenCalled();
  });

  it('renders the result generically as key/value rows plus the warnings list on success', async () => {
    const stake = makeStake();
    mutateAsyncMock.mockResolvedValueOnce({
      ok: true,
      seats_total: 250,
      seats_updated: 7,
      warnings: ['seat alice@x: scope CO unresolved'],
    });
    render(<ApplyFixesMenu stake={stake} />);
    const user = userEvent.setup();
    await openExplain(user, stake);
    await user.click(screen.getByTestId('apply-fixes-apply'));

    await waitFor(() => {
      expect(screen.getByTestId('apply-fixes-result-success')).toBeInTheDocument();
    });
    const rows = screen.getByTestId('apply-fixes-result-rows');
    expect(rows).toHaveTextContent('seats_total');
    expect(rows).toHaveTextContent('250');
    expect(rows).toHaveTextContent('seats_updated');
    expect(rows).toHaveTextContent('7');
    // The warnings array is pulled out of the rows into its own list.
    expect(rows).not.toHaveTextContent('warnings');
    expect(screen.getByTestId('apply-fixes-result-warnings')).toHaveTextContent(
      'seat alice@x: scope CO unresolved',
    );
  });

  it('renders the error code and message when the fix callable rejects', async () => {
    const stake = makeStake();
    mutateAsyncMock.mockRejectedValueOnce(
      Object.assign(new Error('platform superadmin required'), { code: 'permission-denied' }),
    );
    render(<ApplyFixesMenu stake={stake} />);
    const user = userEvent.setup();
    await openExplain(user, stake);
    await user.click(screen.getByTestId('apply-fixes-apply'));

    await waitFor(() => {
      expect(screen.getByTestId('apply-fixes-result-error')).toBeInTheDocument();
    });
    expect(screen.getByTestId('apply-fixes-error-code')).toHaveTextContent('permission-denied');
    expect(screen.getByTestId('apply-fixes-error-message')).toHaveTextContent(
      'platform superadmin required',
    );
  });

  it('copies the formatted result to the clipboard via the Copy button', async () => {
    const stake = makeStake();
    mutateAsyncMock.mockResolvedValueOnce({ ok: true, seats_updated: 4 });
    render(<ApplyFixesMenu stake={stake} />);
    const user = userEvent.setup();
    // Install the spy AFTER userEvent.setup() — setup() swaps in its own
    // clipboard stub, which would otherwise shadow ours.
    const writeText = stubClipboard();
    await openExplain(user, stake);
    await user.click(screen.getByTestId('apply-fixes-apply'));
    await waitFor(() => {
      expect(screen.getByTestId('apply-fixes-result-success')).toBeInTheDocument();
    });
    await user.click(screen.getByTestId('apply-fixes-copy'));

    expect(writeText).toHaveBeenCalledWith('ok: true\nseats_updated: 4');
    expect(toastMock).toHaveBeenCalledWith('Copied to clipboard.', 'success');
  });

  it('copies the formatted error to the clipboard from the error Result dialog', async () => {
    const stake = makeStake();
    mutateAsyncMock.mockRejectedValueOnce(Object.assign(new Error('boom'), { code: 'internal' }));
    render(<ApplyFixesMenu stake={stake} />);
    const user = userEvent.setup();
    const writeText = stubClipboard();
    await openExplain(user, stake);
    await user.click(screen.getByTestId('apply-fixes-apply'));
    await waitFor(() => {
      expect(screen.getByTestId('apply-fixes-result-error')).toBeInTheDocument();
    });
    await user.click(screen.getByTestId('apply-fixes-copy'));

    expect(writeText).toHaveBeenCalledWith('internal: boom');
  });

  it('disables both dialog buttons while the fix is in flight', async () => {
    setPending(true);
    const stake = makeStake();
    render(<ApplyFixesMenu stake={stake} />);
    const user = userEvent.setup();
    await openExplain(user, stake);

    expect(screen.getByTestId('apply-fixes-apply')).toBeDisabled();
    expect(screen.getByTestId('apply-fixes-cancel')).toBeDisabled();
    expect(screen.getByTestId('apply-fixes-apply')).toHaveTextContent('Applying…');
  });

  it('cannot be dismissed via Escape while the fix is in flight, and still renders the result on resolve', async () => {
    const stake = makeStake();
    const d = deferred<Record<string, unknown>>();
    // Keep the mutation in flight and reflect that in `isPending` so the
    // dialog renders as non-dismissable.
    mutateAsyncMock.mockImplementationOnce(() => {
      setPending(true);
      return d.promise;
    });
    render(<ApplyFixesMenu stake={stake} />);
    const user = userEvent.setup();
    await openExplain(user, stake);
    await user.click(screen.getByTestId('apply-fixes-apply'));

    // Mutation is in flight: the explain dialog is still up and Escape
    // must NOT dismiss it (it would otherwise unmount mid-flight and the
    // post-await result would reopen a dialog the user thought closed).
    await waitFor(() => {
      expect(screen.getByTestId('apply-fixes-apply')).toBeDisabled();
    });
    await user.keyboard('{Escape}');
    expect(screen.getByTestId('apply-fixes-explain')).toBeInTheDocument();

    // Resolve the fix: pending clears and the Result dialog renders.
    setPending(false);
    d.resolve({ ok: true, seats_updated: 5 });
    await waitFor(() => {
      expect(screen.getByTestId('apply-fixes-result-success')).toBeInTheDocument();
    });
    expect(screen.getByTestId('apply-fixes-result-rows')).toHaveTextContent('seats_updated');
  });
});
