// Component tests for the manager Audit Log page. Mocks
// `useAuditLogInfinite` so the infinite-scroll + filter rendering is
// exercised without touching Firestore.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AuditLog } from '@kindoo/shared';
import { makeAuditLog } from '../../../../test/fixtures';

const useAuditLogInfiniteMock = vi.fn();
const fetchNextPageMock = vi.fn();
const navigateMock = vi.fn().mockResolvedValue(undefined);

vi.mock('./hooks', async () => {
  const actual = await vi.importActual<typeof import('./hooks')>('./hooks');
  return {
    ...actual,
    useAuditLogInfinite: (filters: unknown) => useAuditLogInfiniteMock(filters),
  };
});

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigateMock,
}));

// Audit Log subscribes to the stake doc for the timezone setting.
vi.mock('../dashboard/hooks', () => ({
  useStakeDoc: () => ({
    data: { timezone: 'UTC' },
    error: null,
    status: 'success',
    isPending: false,
    isLoading: false,
    isSuccess: true,
    isError: false,
    isFetching: false,
    fetchStatus: 'idle',
  }),
}));

import { AuditLogPage } from './AuditLogPage';

interface InfiniteResultOpts {
  pages?: AuditLog[][];
  hasNextPage?: boolean;
  isFetchingNextPage?: boolean;
  isLoading?: boolean;
}

function infiniteResult(opts: InfiniteResultOpts = {}) {
  const pages = opts.pages ?? [[]];
  return {
    data: { pages: pages.map((rows) => ({ rows, nextCursor: null })) },
    error: null,
    status: opts.isLoading ? 'pending' : 'success',
    isPending: opts.isLoading ?? false,
    isLoading: opts.isLoading ?? false,
    isSuccess: !(opts.isLoading ?? false),
    isError: false,
    isFetching: false,
    fetchStatus: 'idle',
    hasNextPage: opts.hasNextPage ?? false,
    isFetchingNextPage: opts.isFetchingNextPage ?? false,
    fetchNextPage: fetchNextPageMock,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  navigateMock.mockResolvedValue(undefined);
  fetchNextPageMock.mockResolvedValue(undefined);
});

describe('<AuditLogPage />', () => {
  it('renders the empty-state copy when zero rows match', () => {
    useAuditLogInfiniteMock.mockReturnValue(infiniteResult({ pages: [[]] }));
    render(<AuditLogPage />);
    expect(screen.getByText(/no audit rows match/i)).toBeInTheDocument();
  });

  it('renders one card per audit row', () => {
    useAuditLogInfiniteMock.mockReturnValue(
      infiniteResult({
        pages: [
          [
            makeAuditLog({ audit_id: 'a1', action: 'create_seat' }),
            makeAuditLog({ audit_id: 'a2', action: 'update_seat' }),
          ],
        ],
      }),
    );
    render(<AuditLogPage />);
    expect(screen.getByTestId('audit-row-a1')).toBeInTheDocument();
    expect(screen.getByTestId('audit-row-a2')).toBeInTheDocument();
  });

  it('flattens multiple infinite-query pages into a single row list', () => {
    useAuditLogInfiniteMock.mockReturnValue(
      infiniteResult({
        pages: [
          [makeAuditLog({ audit_id: 'p1-a' }), makeAuditLog({ audit_id: 'p1-b' })],
          [makeAuditLog({ audit_id: 'p2-a' })],
        ],
      }),
    );
    render(<AuditLogPage />);
    expect(screen.getByTestId('audit-row-p1-a')).toBeInTheDocument();
    expect(screen.getByTestId('audit-row-p1-b')).toBeInTheDocument();
    expect(screen.getByTestId('audit-row-p2-a')).toBeInTheDocument();
  });

  it('shows "No more entries." when the infinite query has no more pages', () => {
    useAuditLogInfiniteMock.mockReturnValue(
      infiniteResult({
        pages: [[makeAuditLog({ audit_id: 'a1' })]],
        hasNextPage: false,
      }),
    );
    render(<AuditLogPage />);
    expect(screen.getByTestId('audit-log-end')).toHaveTextContent('No more entries.');
  });

  it('does not show the "No more entries." marker while a next page is available', () => {
    useAuditLogInfiniteMock.mockReturnValue(
      infiniteResult({
        pages: [[makeAuditLog({ audit_id: 'a1' })]],
        hasNextPage: true,
      }),
    );
    render(<AuditLogPage />);
    expect(screen.queryByTestId('audit-log-end')).toBeNull();
  });

  it('renders the timestamp in the stake-doc timezone', () => {
    useAuditLogInfiniteMock.mockReturnValue(
      infiniteResult({ pages: [[makeAuditLog({ audit_id: 'a1' })]] }),
    );
    render(<AuditLogPage />);
    const card = screen.getByTestId('audit-row-a1');
    expect(within(card).getByText('2026-04-28 12:00 pm')).toBeInTheDocument();
  });

  it('seeds the entity_id filter from the deep-link prop', () => {
    useAuditLogInfiniteMock.mockReturnValue(
      infiniteResult({ pages: [[makeAuditLog({ audit_id: 'a1' })]] }),
    );
    render(<AuditLogPage initialFilters={{ entity_id: 'bob@example.com' }} />);
    const entityIdInput = screen.getByPlaceholderText(/ID or email/i) as HTMLInputElement;
    expect(entityIdInput.value).toBe('bob@example.com');
  });

  it('expands the diff details when the user clicks the summary', async () => {
    const user = userEvent.setup();
    useAuditLogInfiniteMock.mockReturnValue(
      infiniteResult({
        pages: [
          [
            makeAuditLog({
              audit_id: 'a1',
              before: null,
              after: { member_email: 'bob@example.com', scope: 'CO', type: 'auto' },
            }),
          ],
        ],
      }),
    );
    render(<AuditLogPage />);
    const card = screen.getByTestId('audit-row-a1');
    const details = card.querySelector('details');
    if (!details) throw new Error('details element missing');
    expect(details.open).toBe(false);
    await user.click(details.querySelector('summary')!);
    expect(details.open).toBe(true);
    const table = within(card).getByTestId('audit-diff-table');
    expect(within(table).getByText('bob@example.com')).toBeInTheDocument();
    expect(within(table).getByText('CO')).toBeInTheDocument();
    expect(within(table).getByText('auto')).toBeInTheDocument();
  });

  it('surfaces the completion_note inline on R-1 complete_request rows', () => {
    useAuditLogInfiniteMock.mockReturnValue(
      infiniteResult({
        pages: [
          [
            makeAuditLog({
              audit_id: 'a1',
              action: 'complete_request',
              before: { status: 'pending' },
              after: {
                status: 'complete',
                completion_note: 'Seat already removed at completion time (no-op).',
              },
            }),
          ],
        ],
      }),
    );
    render(<AuditLogPage />);
    const card = screen.getByTestId('audit-row-a1');
    const summary = card.querySelector('.kd-audit-card-summary');
    expect(summary?.textContent).toMatch(/seat already removed at completion time/i);
  });

  it('does not render Next/Prev pagination controls (replaced by infinite scroll)', () => {
    useAuditLogInfiniteMock.mockReturnValue(
      infiniteResult({ pages: [[makeAuditLog({ audit_id: 'a1' })]] }),
    );
    render(<AuditLogPage />);
    expect(screen.queryByRole('button', { name: /next/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /prev/i })).toBeNull();
    expect(screen.queryByTestId('audit-page-counter')).toBeNull();
  });

  it('renders the infinite-scroll sentinel when rows are present', () => {
    useAuditLogInfiniteMock.mockReturnValue(
      infiniteResult({
        pages: [[makeAuditLog({ audit_id: 'a1' })]],
        hasNextPage: true,
      }),
    );
    render(<AuditLogPage />);
    expect(screen.getByTestId('audit-log-sentinel')).toBeInTheDocument();
  });

  describe('action-badge color categories', () => {
    function renderRowWithAction(action: string) {
      useAuditLogInfiniteMock.mockReturnValue(
        infiniteResult({
          pages: [[makeAuditLog({ audit_id: 'a1', action: action as never })]],
        }),
      );
      render(<AuditLogPage />);
      const card = screen.getByTestId('audit-row-a1');
      const badge = within(card).getByText(action);
      return badge;
    }

    it('paints CRUD actions with the audit-crud (blue) classes', () => {
      const badge = renderRowWithAction('create_seat');
      expect(badge.className).toContain('bg-kd-primary-tint');
      expect(badge.className).toContain('text-kd-primary');
    });

    it('paints request-lifecycle actions with the audit-request (green) classes', () => {
      const badge = renderRowWithAction('submit_request');
      expect(badge.className).toContain('bg-kd-success-tint');
      expect(badge.className).toContain('text-kd-success-fg');
    });

    it('paints system events with the audit-system (red) classes', () => {
      const badge = renderRowWithAction('over_cap_warning');
      expect(badge.className).toContain('bg-kd-danger-tint');
      expect(badge.className).toContain('text-kd-danger-fg');
    });

    it('paints reject_request with the audit-system (red) classes', () => {
      const badge = renderRowWithAction('reject_request');
      expect(badge.className).toContain('bg-kd-danger-tint');
      expect(badge.className).toContain('text-kd-danger-fg');
    });

    it('paints importer actions with the audit-import (amber) classes', () => {
      const badge = renderRowWithAction('import_end');
      expect(badge.className).toContain('bg-kd-warn-tint-2');
      expect(badge.className).toContain('text-kd-warn-mid');
    });
  });

  describe('automated-actor chip', () => {
    it('paints the Importer actor with the actor-automated chip styling', () => {
      useAuditLogInfiniteMock.mockReturnValue(
        infiniteResult({
          pages: [[makeAuditLog({ audit_id: 'a1', actor_email: 'Importer' })]],
        }),
      );
      render(<AuditLogPage />);
      const card = screen.getByTestId('audit-row-a1');
      const actor = card.querySelector('.kd-audit-card-actor');
      expect(actor?.className).toContain('actor-automated');
    });

    it('paints ExpiryTrigger the same way', () => {
      useAuditLogInfiniteMock.mockReturnValue(
        infiniteResult({
          pages: [[makeAuditLog({ audit_id: 'a1', actor_email: 'ExpiryTrigger' })]],
        }),
      );
      render(<AuditLogPage />);
      const card = screen.getByTestId('audit-row-a1');
      const actor = card.querySelector('.kd-audit-card-actor');
      expect(actor?.className).toContain('actor-automated');
    });

    it('does not paint a real-user email as automated', () => {
      useAuditLogInfiniteMock.mockReturnValue(
        infiniteResult({
          pages: [[makeAuditLog({ audit_id: 'a1', actor_email: 'alice@example.com' })]],
        }),
      );
      render(<AuditLogPage />);
      const card = screen.getByTestId('audit-row-a1');
      const actor = card.querySelector('.kd-audit-card-actor');
      expect(actor?.className ?? '').not.toContain('actor-automated');
    });
  });
});
