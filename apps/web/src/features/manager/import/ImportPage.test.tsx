// Component tests for the Import page. Covers:
//   - Status row rendering from the live stake doc.
//   - Over-cap banner appears when last_over_caps_json is non-empty,
//     hides when empty (clears reactively).
//   - "Import Now" loading / success / error states render inline.
//   - The button click drives the mutation; the rendered summary
//     shows insert / update / delete / duration / errors.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ImportSummary, Stake } from '@kindoo/shared';

const useStakeDocMock = vi.fn();
const useRunImportNowMutationMock = vi.fn();

vi.mock('./hooks', () => ({
  useStakeDoc: () => useStakeDocMock(),
  useRunImportNowMutation: () => useRunImportNowMutationMock(),
}));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, ...rest }: { children: React.ReactNode } & Record<string, unknown>) => (
    // eslint-disable-next-line jsx-a11y/anchor-is-valid
    <a {...(rest as Record<string, unknown>)}>{children}</a>
  ),
}));

import { ImportPage } from './ImportPage';

function makeStake(over: Partial<Stake> = {}): Partial<Stake> {
  return {
    stake_name: 'My Stake',
    callings_sheet_id: 'sheet1',
    last_import_summary: 'OK',
    last_over_caps_json: [],
    import_day: 'MONDAY',
    import_hour: 6,
    timezone: 'America/Denver',
    ...over,
  };
}

function stakeResult(data: Partial<Stake> | undefined) {
  return {
    data,
    error: null,
    status: 'success',
    isPending: false,
    isLoading: false,
    isSuccess: true,
    isError: false,
    isFetching: false,
    fetchStatus: 'idle',
  };
}

interface MutationStub {
  mutateAsync: ReturnType<typeof vi.fn>;
  isPending: boolean;
  data: ImportSummary | undefined;
  error: Error | null;
}

function mutationStub(over: Partial<MutationStub> = {}): MutationStub {
  return {
    mutateAsync: vi.fn(),
    isPending: false,
    data: undefined,
    error: null,
    ...over,
  };
}

function summary(over: Partial<ImportSummary> = {}): ImportSummary {
  return {
    ok: true,
    inserted: 0,
    deleted: 0,
    updated: 0,
    access_added: 0,
    access_removed: 0,
    warnings: [],
    skipped_tabs: [],
    over_caps: [],
    elapsed_ms: 0,
    triggered_by: 'manager@example.com',
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  useRunImportNowMutationMock.mockReturnValue(mutationStub());
});

describe('<ImportPage />', () => {
  it('renders the Import Now button and status block from the stake doc', () => {
    useStakeDocMock.mockReturnValue(stakeResult(makeStake()));
    render(<ImportPage />);
    expect(screen.getByTestId('import-now-button')).toHaveTextContent('Import Now');
    expect(screen.getByTestId('import-last-summary')).toHaveTextContent('OK');
    expect(screen.getByTestId('import-callings-sheet-id')).toHaveTextContent('sheet1');
  });

  it('renders the over-cap banner when stake.last_over_caps_json has entries', () => {
    useStakeDocMock.mockReturnValue(
      stakeResult(
        makeStake({
          last_over_caps_json: [
            { pool: 'CO', count: 22, cap: 20, over_by: 2 },
            { pool: 'stake', count: 250, cap: 200, over_by: 50 },
          ],
        }),
      ),
    );
    render(<ImportPage />);
    expect(screen.getByTestId('import-over-cap-banner')).toBeInTheDocument();
    expect(screen.getByTestId('import-over-cap-row-CO')).toHaveTextContent(/22 \/ 20/);
    expect(screen.getByTestId('import-over-cap-row-stake')).toHaveTextContent(/250 \/ 200/);
  });

  it('omits the over-cap banner when last_over_caps_json is empty', () => {
    useStakeDocMock.mockReturnValue(stakeResult(makeStake({ last_over_caps_json: [] })));
    render(<ImportPage />);
    expect(screen.queryByTestId('import-over-cap-banner')).toBeNull();
  });

  it('shows a busy label and disables the button while the mutation is pending', () => {
    useStakeDocMock.mockReturnValue(stakeResult(makeStake()));
    useRunImportNowMutationMock.mockReturnValue(mutationStub({ isPending: true }));
    render(<ImportPage />);
    const btn = screen.getByTestId('import-now-button') as HTMLButtonElement;
    expect(btn).toBeDisabled();
    expect(btn).toHaveTextContent('Importing…');
  });

  it('invokes the mutation when Import Now is clicked', async () => {
    const mutateAsync = vi.fn().mockResolvedValueOnce(summary({ inserted: 3, updated: 1 }));
    useRunImportNowMutationMock.mockReturnValue(mutationStub({ mutateAsync }));
    useStakeDocMock.mockReturnValue(stakeResult(makeStake()));
    const user = userEvent.setup();
    render(<ImportPage />);
    await user.click(screen.getByTestId('import-now-button'));
    expect(mutateAsync).toHaveBeenCalledTimes(1);
  });

  it('renders the typed summary inline on success', () => {
    useStakeDocMock.mockReturnValue(stakeResult(makeStake()));
    useRunImportNowMutationMock.mockReturnValue(
      mutationStub({
        data: summary({
          inserted: 5,
          updated: 2,
          deleted: 1,
          access_added: 4,
          access_removed: 0,
          elapsed_ms: 2400,
          triggered_by: 'tad@example.com',
          warnings: ['CallerNotFound: jane@example.com'],
        }),
      }),
    );
    render(<ImportPage />);
    const card = screen.getByTestId('import-summary');
    expect(card).toHaveAttribute('data-summary-status', 'ok');
    expect(screen.getByTestId('import-summary-inserted')).toHaveTextContent('5');
    expect(screen.getByTestId('import-summary-updated')).toHaveTextContent('2');
    expect(screen.getByTestId('import-summary-deleted')).toHaveTextContent('1');
    expect(screen.getByTestId('import-summary-access-added')).toHaveTextContent('4');
    expect(screen.getByTestId('import-summary-elapsed')).toHaveTextContent('2.4 s');
    expect(screen.getByTestId('import-summary-triggered-by')).toHaveTextContent('tad@example.com');
    expect(screen.getByTestId('import-summary-warnings')).toHaveTextContent('Warnings (1)');
  });

  it('renders a failure summary when ImportSummary.ok is false', () => {
    useStakeDocMock.mockReturnValue(stakeResult(makeStake()));
    useRunImportNowMutationMock.mockReturnValue(
      mutationStub({
        data: summary({ ok: false, error: 'Sheet API: 403 forbidden', elapsed_ms: 850 }),
      }),
    );
    render(<ImportPage />);
    const card = screen.getByTestId('import-summary');
    expect(card).toHaveAttribute('data-summary-status', 'fail');
    expect(screen.getByTestId('import-summary-error')).toHaveTextContent(
      'Sheet API: 403 forbidden',
    );
    expect(screen.getByTestId('import-summary-elapsed')).toHaveTextContent('850 ms');
  });

  it('renders the inline error block when the callable rejects', () => {
    useStakeDocMock.mockReturnValue(stakeResult(makeStake()));
    useRunImportNowMutationMock.mockReturnValue(
      mutationStub({
        error: new Error('permission-denied: caller is not a manager of this stake'),
      }),
    );
    render(<ImportPage />);
    expect(screen.getByTestId('import-error')).toHaveTextContent(
      /caller is not a manager of this stake/,
    );
  });
});
