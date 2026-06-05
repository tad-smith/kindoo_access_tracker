// Component tests for QueuePanel's section layout + seat-existence
// overlay. Mocks the extensionApi callable wrappers and stubs
// RequestCard so the assertions stay on what QueuePanel owns:
//   - three ordered sections (Urgent → Outstanding → Future) with open
//     counts, empty sections hidden
//   - cards within a section in comparison-date order
//   - overall empty-state + Refresh
//   - seat-existence map threaded into each card's `memberHasSeat`,
//     resilient to per-lookup failures
//
// The provision / reject behaviour itself lives in RequestCard.test.tsx.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const getMyPendingRequestsMock = vi.fn();
const getSeatByEmailMock = vi.fn();

vi.mock('../lib/extensionApi', async () => {
  const actual = await vi.importActual<typeof import('../lib/extensionApi')>('../lib/extensionApi');
  return {
    ...actual,
    getMyPendingRequests: (...args: unknown[]) => getMyPendingRequestsMock(...args),
    getSeatByEmail: (...args: unknown[]) => getSeatByEmailMock(...args),
  };
});

// Stub RequestCard — render its id + memberHasSeat as test markers so
// QueuePanel's wiring is observable without exercising the provision
// machinery.
vi.mock('./RequestCard', () => ({
  RequestCard: (props: { request: { request_id: string }; memberHasSeat: boolean }) => (
    <div
      data-testid={`card-${props.request.request_id}`}
      data-has-seat={props.memberHasSeat ? 'true' : 'false'}
    />
  ),
}));

import type { AccessRequest } from '@kindoo/shared';
import type { StakeConfigBundle } from '../lib/extensionApi';

function bundle(): StakeConfigBundle {
  return {
    stake: { stake_id: 'csnorth', stake_name: 'CS North' } as unknown as StakeConfigBundle['stake'],
    buildings: [],
    wards: [],
    kindooSites: [],
  };
}

function wireTs(iso: string): AccessRequest['requested_at'] {
  const ms = new Date(iso).getTime();
  return {
    seconds: Math.floor(ms / 1000),
    nanoseconds: 0,
  } as unknown as AccessRequest['requested_at'];
}

function req(overrides: Partial<AccessRequest> = {}): AccessRequest {
  return {
    request_id: 'r',
    type: 'add_manual',
    scope: 'stake',
    member_email: 'm@example.com',
    member_canonical: 'm@example.com',
    member_name: 'Member',
    reason: '',
    comment: '',
    building_names: [],
    status: 'pending',
    requester_email: 'req@example.com',
    requester_canonical: 'req@example.com',
    requested_at: wireTs('2026-06-01T08:00:00Z'),
    lastActor: { email: 'a@x', canonical: 'a@x' },
    ...overrides,
  } as AccessRequest;
}

async function renderPanel(onPermissionDenied = vi.fn()) {
  const { QueuePanel } = await import('./QueuePanel');
  return render(
    <QueuePanel stakeId="csnorth" bundle={bundle()} onPermissionDenied={onPermissionDenied} />,
  );
}

describe('QueuePanel', () => {
  beforeEach(() => {
    getMyPendingRequestsMock.mockReset();
    getSeatByEmailMock.mockReset();
    getSeatByEmailMock.mockResolvedValue(null);
  });
  afterEach(() => {
    vi.resetModules();
  });

  it('shows the empty-state when there are no pending requests', async () => {
    getMyPendingRequestsMock.mockResolvedValue({ requests: [] });
    await renderPanel();
    await waitFor(() => expect(screen.getByTestId('sba-queue-empty')).toBeInTheDocument());
    expect(screen.queryByTestId('sba-queue-sections')).not.toBeInTheDocument();
  });

  it('renders only non-empty sections, each with its open count', async () => {
    // Pin "now" so the outstanding/future boundary is deterministic.
    vi.setSystemTime(new Date(2026, 5, 1, 12, 0, 0)); // 2026-06-01 noon local
    getMyPendingRequestsMock.mockResolvedValue({
      requests: [
        req({ request_id: 'urg', urgent: true }),
        req({ request_id: 'out', requested_at: wireTs('2026-06-02T08:00:00Z') }),
        // No future request → Future section must be absent.
      ],
    });
    await renderPanel();

    await waitFor(() => expect(screen.getByTestId('sba-queue-section-urgent')).toBeInTheDocument());
    expect(screen.getByTestId('sba-queue-section-urgent')).toHaveTextContent('Urgent Requests (1)');
    expect(screen.getByTestId('sba-queue-section-outstanding')).toHaveTextContent(
      'Outstanding Requests (1)',
    );
    expect(screen.queryByTestId('sba-queue-section-future')).not.toBeInTheDocument();
    vi.useRealTimers();
  });

  it('orders cards within a section by comparison date ascending', async () => {
    vi.setSystemTime(new Date(2026, 5, 1, 12, 0, 0));
    getMyPendingRequestsMock.mockResolvedValue({
      requests: [
        req({ request_id: 'late', requested_at: wireTs('2026-06-03T08:00:00Z') }),
        req({ request_id: 'early', requested_at: wireTs('2026-06-01T08:00:00Z') }),
        req({ request_id: 'mid', requested_at: wireTs('2026-06-02T08:00:00Z') }),
      ],
    });
    await renderPanel();

    await waitFor(() =>
      expect(screen.getByTestId('sba-queue-section-outstanding')).toBeInTheDocument(),
    );
    const section = screen.getByTestId('sba-queue-section-outstanding');
    const ids = within(section)
      .getAllByTestId(/^card-/)
      .map((el) => el.getAttribute('data-testid'));
    expect(ids).toEqual(['card-early', 'card-mid', 'card-late']);
    vi.useRealTimers();
  });

  it('threads seat-existence into each add card and ignores lookup failures', async () => {
    getMyPendingRequestsMock.mockResolvedValue({
      requests: [
        req({ request_id: 'has-seat', member_canonical: 'a@x' }),
        req({ request_id: 'no-seat', member_canonical: 'b@x' }),
        req({ request_id: 'errored', member_canonical: 'c@x' }),
      ],
    });
    getSeatByEmailMock.mockImplementation((_stakeId: string, canonical: string) => {
      if (canonical === 'a@x') return Promise.resolve({ member_canonical: 'a@x' });
      if (canonical === 'b@x') return Promise.resolve(null);
      return Promise.reject(new Error('read failed'));
    });
    await renderPanel();

    await waitFor(() => expect(screen.getByTestId('card-has-seat')).toBeInTheDocument());
    expect(screen.getByTestId('card-has-seat')).toHaveAttribute('data-has-seat', 'true');
    expect(screen.getByTestId('card-no-seat')).toHaveAttribute('data-has-seat', 'false');
    // Failed lookup falls back to "not blocked".
    expect(screen.getByTestId('card-errored')).toHaveAttribute('data-has-seat', 'false');
  });

  it('does not run seat lookups for non-add request types', async () => {
    getMyPendingRequestsMock.mockResolvedValue({
      requests: [req({ request_id: 'rm', type: 'remove' })],
    });
    await renderPanel();
    await waitFor(() => expect(screen.getByTestId('card-rm')).toBeInTheDocument());
    expect(getSeatByEmailMock).not.toHaveBeenCalled();
  });

  it('routes permission-denied to onPermissionDenied', async () => {
    getMyPendingRequestsMock.mockRejectedValue(
      Object.assign(new Error('denied'), { code: 'permission-denied' }),
    );
    const onPermissionDenied = vi.fn();
    await renderPanel(onPermissionDenied);
    await waitFor(() => expect(onPermissionDenied).toHaveBeenCalledTimes(1));
  });

  it('surfaces a non-permission error inline', async () => {
    getMyPendingRequestsMock.mockRejectedValue(new Error('network down'));
    await renderPanel();
    await waitFor(() =>
      expect(screen.getByTestId('sba-queue-error')).toHaveTextContent('network down'),
    );
  });

  it('refetches on Refresh', async () => {
    getMyPendingRequestsMock.mockResolvedValue({ requests: [] });
    const user = userEvent.setup();
    await renderPanel();
    await waitFor(() => expect(screen.getByTestId('sba-queue-empty')).toBeInTheDocument());
    expect(getMyPendingRequestsMock).toHaveBeenCalledTimes(1);
    await user.click(screen.getByTestId('sba-refresh'));
    await waitFor(() => expect(getMyPendingRequestsMock).toHaveBeenCalledTimes(2));
  });
});
