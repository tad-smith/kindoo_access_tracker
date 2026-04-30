// Component tests for the manager Audit Log page. Mocks
// `useAuditLogPage` so the cursor pagination + filter rendering is
// exercised without touching Firestore.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AuditLog } from '@kindoo/shared';
import { makeAuditLog } from '../../../../test/fixtures';

const useAuditLogPageMock = vi.fn();
const navigateMock = vi.fn().mockResolvedValue(undefined);

vi.mock('./hooks', async () => {
  const actual = await vi.importActual<typeof import('./hooks')>('./hooks');
  return {
    ...actual,
    useAuditLogPage: (filters: unknown, cursor: unknown) => useAuditLogPageMock(filters, cursor),
  };
});

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigateMock,
}));

// Audit Log subscribes to the stake doc for the timezone setting.
// Mock the dashboard hook with a stub stake (UTC) so the timestamp
// column has a deterministic timezone in tests.
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
import { PAGE_SIZE } from './hooks';

function liveResult<T>(data: T[] | undefined, isLoading = false) {
  return {
    data,
    error: null,
    status: isLoading ? 'pending' : 'success',
    isPending: isLoading,
    isLoading,
    isSuccess: !isLoading,
    isError: false,
    isFetching: false,
    fetchStatus: 'idle',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  navigateMock.mockResolvedValue(undefined);
});

describe('<AuditLogPage />', () => {
  it('renders the empty-state copy when zero rows match', () => {
    useAuditLogPageMock.mockReturnValue(liveResult<AuditLog>([]));
    render(<AuditLogPage />);
    expect(screen.getByText(/no audit rows match/i)).toBeInTheDocument();
  });

  it('renders one card per audit row', () => {
    useAuditLogPageMock.mockReturnValue(
      liveResult([
        makeAuditLog({ audit_id: 'a1', action: 'create_seat' }),
        makeAuditLog({ audit_id: 'a2', action: 'update_seat' }),
      ]),
    );
    render(<AuditLogPage />);
    expect(screen.getByTestId('audit-row-a1')).toBeInTheDocument();
    expect(screen.getByTestId('audit-row-a2')).toBeInTheDocument();
  });

  it('shows Page 1 + the row count in the pagination header', () => {
    useAuditLogPageMock.mockReturnValue(liveResult([makeAuditLog({ audit_id: 'a1' })]));
    render(<AuditLogPage />);
    expect(screen.getByTestId('audit-page-counter')).toHaveTextContent(/page 1 · 1 row/i);
  });

  it('disables Next when fewer rows than PAGE_SIZE returned', () => {
    useAuditLogPageMock.mockReturnValue(liveResult([makeAuditLog({ audit_id: 'a1' })]));
    render(<AuditLogPage />);
    expect(screen.getByRole('button', { name: /next/i })).toBeDisabled();
  });

  it('enables Next when exactly PAGE_SIZE rows returned', () => {
    const rows = Array.from({ length: PAGE_SIZE }, (_, i) => makeAuditLog({ audit_id: `a${i}` }));
    useAuditLogPageMock.mockReturnValue(liveResult(rows));
    render(<AuditLogPage />);
    expect(screen.getByRole('button', { name: /next/i })).not.toBeDisabled();
  });

  it('disables Prev on the first page', () => {
    useAuditLogPageMock.mockReturnValue(liveResult([makeAuditLog({ audit_id: 'a1' })]));
    render(<AuditLogPage />);
    expect(screen.getByRole('button', { name: /prev/i })).toBeDisabled();
  });

  it('renders the timestamp in the stake-doc timezone', () => {
    // Stake mocked to UTC. NOW = 2026-04-28T12:00:00Z → 12:00 pm UTC.
    useAuditLogPageMock.mockReturnValue(liveResult([makeAuditLog({ audit_id: 'a1' })]));
    render(<AuditLogPage />);
    const card = screen.getByTestId('audit-row-a1');
    expect(within(card).getByText('2026-04-28 12:00 pm')).toBeInTheDocument();
  });

  it('seeds the entity_id filter from the deep-link prop', () => {
    useAuditLogPageMock.mockReturnValue(liveResult([makeAuditLog({ audit_id: 'a1' })]));
    render(<AuditLogPage initialFilters={{ entity_id: 'bob@example.com' }} />);
    const entityIdInput = screen.getByPlaceholderText(/ID or email/i) as HTMLInputElement;
    expect(entityIdInput.value).toBe('bob@example.com');
  });

  it('expands the diff details when the user clicks the summary', async () => {
    const user = userEvent.setup();
    useAuditLogPageMock.mockReturnValue(
      liveResult([
        makeAuditLog({
          audit_id: 'a1',
          before: null,
          after: { member_email: 'bob@example.com', scope: 'CO', type: 'auto' },
        }),
      ]),
    );
    render(<AuditLogPage />);
    const card = screen.getByTestId('audit-row-a1');
    const details = card.querySelector('details');
    if (!details) throw new Error('details element missing');
    expect(details.open).toBe(false);
    await user.click(details.querySelector('summary')!);
    expect(details.open).toBe(true);
    // Expanded: field-by-field diff table renders one row per
    // changed/added field; the value cell carries the after-side
    // contents.
    const table = within(card).getByTestId('audit-diff-table');
    expect(within(table).getByText('bob@example.com')).toBeInTheDocument();
    expect(within(table).getByText('CO')).toBeInTheDocument();
    expect(within(table).getByText('auto')).toBeInTheDocument();
  });

  it('surfaces the completion_note inline on R-1 complete_request rows', () => {
    useAuditLogPageMock.mockReturnValue(
      liveResult([
        makeAuditLog({
          audit_id: 'a1',
          action: 'complete_request',
          before: { status: 'pending' },
          after: {
            status: 'complete',
            completion_note: 'Seat already removed at completion time (no-op).',
          },
        }),
      ]),
    );
    render(<AuditLogPage />);
    // The note shows up in the collapsed summary text.
    const card = screen.getByTestId('audit-row-a1');
    const summary = card.querySelector('.kd-audit-card-summary');
    expect(summary?.textContent).toMatch(/seat already removed at completion time/i);
  });

  it('advances the cursor on Next click', async () => {
    const user = userEvent.setup();
    const rows = Array.from({ length: PAGE_SIZE }, (_, i) => makeAuditLog({ audit_id: `a${i}` }));
    useAuditLogPageMock.mockReturnValue(liveResult(rows));
    render(<AuditLogPage />);
    expect(screen.getByTestId('audit-page-counter')).toHaveTextContent(/page 1/i);
    await user.click(screen.getByRole('button', { name: /next/i }));
    expect(screen.getByTestId('audit-page-counter')).toHaveTextContent(/page 2/i);
    // The hook was called with a non-null cursor on the second invocation.
    const lastCall = useAuditLogPageMock.mock.calls.at(-1);
    expect(lastCall?.[1]).not.toBeNull();
  });

  describe('action-badge color categories', () => {
    // Each row's action chip should pick up the Apps Script color
    // category for that action: blue (CRUD), green (request), red
    // (system), amber (importer). The Tailwind classes that drive
    // those colors come from the Badge component's `audit-*` variants;
    // we verify the right variant landed by class-name match.
    function renderRowWithAction(action: string) {
      useAuditLogPageMock.mockReturnValue(
        liveResult([makeAuditLog({ audit_id: 'a1', action: action as never })]),
      );
      render(<AuditLogPage />);
      const card = screen.getByTestId('audit-row-a1');
      // The Badge renders as a span with the action text + variant
      // classes; find it by its action-text content.
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
      useAuditLogPageMock.mockReturnValue(
        liveResult([makeAuditLog({ audit_id: 'a1', actor_email: 'Importer' })]),
      );
      render(<AuditLogPage />);
      const card = screen.getByTestId('audit-row-a1');
      const actor = card.querySelector('.kd-audit-card-actor');
      expect(actor?.className).toContain('actor-automated');
    });

    it('paints ExpiryTrigger the same way', () => {
      useAuditLogPageMock.mockReturnValue(
        liveResult([makeAuditLog({ audit_id: 'a1', actor_email: 'ExpiryTrigger' })]),
      );
      render(<AuditLogPage />);
      const card = screen.getByTestId('audit-row-a1');
      const actor = card.querySelector('.kd-audit-card-actor');
      expect(actor?.className).toContain('actor-automated');
    });

    it('does not paint a real-user email as automated', () => {
      useAuditLogPageMock.mockReturnValue(
        liveResult([makeAuditLog({ audit_id: 'a1', actor_email: 'alice@example.com' })]),
      );
      render(<AuditLogPage />);
      const card = screen.getByTestId('audit-row-a1');
      const actor = card.querySelector('.kd-audit-card-actor');
      expect(actor?.className ?? '').not.toContain('actor-automated');
    });
  });
});
