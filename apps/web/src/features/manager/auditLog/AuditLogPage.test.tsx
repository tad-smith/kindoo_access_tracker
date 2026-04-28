// Component tests for the manager Audit Log page. Mocks
// `useAuditLogPage` so the cursor pagination + filter rendering is
// exercised without touching Firestore.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
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

  it('seeds the entity_id filter from the deep-link prop', () => {
    useAuditLogPageMock.mockReturnValue(liveResult([makeAuditLog({ audit_id: 'a1' })]));
    render(<AuditLogPage initialFilters={{ entity_id: 'bob@example.com' }} />);
    const entityIdInput = screen.getByPlaceholderText(/exact match/i) as HTMLInputElement;
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
    expect(card.querySelector('pre')).toHaveTextContent(/bob@example\.com/);
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
});
