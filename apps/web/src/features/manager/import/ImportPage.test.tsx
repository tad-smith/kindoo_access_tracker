// Component tests for the Import page. Covers:
//   - Status row rendering with current stake fields.
//   - Over-cap banner appears when last_over_caps_json is non-empty.
//   - "Import Now" click invokes the callable wrapper (mocked).

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Stake } from '@kindoo/shared';

const useStakeDocMock = vi.fn();
const invokeRunImportNowMock = vi.fn();

vi.mock('./hooks', () => ({
  useStakeDoc: () => useStakeDocMock(),
}));
vi.mock('../../bootstrap/callables', () => ({
  invokeRunImportNow: (...args: unknown[]) => invokeRunImportNowMock(...args),
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

beforeEach(() => {
  vi.clearAllMocks();
});

describe('<ImportPage />', () => {
  it('renders the Import Now button + status block', () => {
    useStakeDocMock.mockReturnValue(stakeResult(makeStake()));
    render(<ImportPage />);
    expect(screen.getByTestId('import-now-button')).toBeInTheDocument();
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

  it('invokes the callable when Import Now is clicked', async () => {
    invokeRunImportNowMock.mockResolvedValueOnce({ ok: true, summary: 'Done.' });
    useStakeDocMock.mockReturnValue(stakeResult(makeStake()));
    const user = userEvent.setup();
    render(<ImportPage />);
    await user.click(screen.getByTestId('import-now-button'));
    expect(invokeRunImportNowMock).toHaveBeenCalledWith('csnorth');
  });
});
