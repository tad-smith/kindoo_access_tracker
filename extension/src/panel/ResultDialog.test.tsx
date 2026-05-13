// Unit tests for the v2.2 ResultDialog. Pure rendering — no SW round
// trips. The component takes a `state` discriminator (ok | partial)
// and an `onDismiss` callback; the partial branch also takes an
// `onRetrySba` async callback.

import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ResultDialog } from './ResultDialog';

describe('ResultDialog', () => {
  it('renders the note and a single Dismiss button in the ok mode', async () => {
    const onDismiss = vi.fn();
    render(<ResultDialog state={{ kind: 'ok', note: 'Added X.' }} onDismiss={onDismiss} />);

    expect(screen.getByTestId('sba-result-note')).toHaveTextContent('Added X.');
    expect(screen.getByTestId('sba-result-dismiss')).toBeInTheDocument();
    expect(screen.queryByTestId('sba-result-retry')).not.toBeInTheDocument();
  });

  it('renders the partial-success error message + a retry button in the partial mode', () => {
    const onRetrySba = vi.fn();
    const onDismiss = vi.fn();
    render(
      <ResultDialog
        state={{
          kind: 'partial',
          note: 'Added X.',
          errorMessage: 'SBA down',
          onRetrySba,
        }}
        onDismiss={onDismiss}
      />,
    );

    expect(screen.getByTestId('sba-result-note')).toHaveTextContent('Added X.');
    expect(screen.getByTestId('sba-result-partial-error')).toHaveTextContent('SBA down');
    expect(screen.getByTestId('sba-result-retry')).toBeInTheDocument();
  });

  it('calls onDismiss when the Dismiss button is clicked', async () => {
    const onDismiss = vi.fn();
    const user = userEvent.setup();
    render(<ResultDialog state={{ kind: 'ok', note: 'Done.' }} onDismiss={onDismiss} />);
    await user.click(screen.getByTestId('sba-result-dismiss'));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('runs onRetrySba when the retry button is clicked and renders the retry-error if it rejects', async () => {
    const onRetrySba = vi.fn().mockRejectedValue(new Error('still down'));
    const onDismiss = vi.fn();
    const user = userEvent.setup();
    render(
      <ResultDialog
        state={{
          kind: 'partial',
          note: 'Added X.',
          errorMessage: 'SBA down',
          onRetrySba,
        }}
        onDismiss={onDismiss}
      />,
    );
    await user.click(screen.getByTestId('sba-result-retry'));
    expect(onRetrySba).toHaveBeenCalledTimes(1);
    await screen.findByTestId('sba-result-retry-error');
    expect(screen.getByTestId('sba-result-retry-error')).toHaveTextContent('still down');
  });

  it('renders the over-cap warning in ok mode when over_caps is non-empty', () => {
    render(
      <ResultDialog
        state={{
          kind: 'ok',
          note: 'Added.',
          over_caps: [{ pool: 'stake', count: 351, cap: 350, over_by: 1 }],
        }}
        onDismiss={vi.fn()}
      />,
    );

    const warning = screen.getByTestId('sba-result-overcap');
    expect(warning).toBeInTheDocument();
    expect(warning).toHaveTextContent(/Stake-wide/);
    expect(warning).toHaveTextContent(/351 \/ 350/);
    expect(warning).toHaveTextContent(/\+1/);
  });

  it('renders one row per pool, labelling ward pools by ward code', () => {
    render(
      <ResultDialog
        state={{
          kind: 'ok',
          note: 'Added.',
          over_caps: [
            { pool: 'stake', count: 351, cap: 350, over_by: 1 },
            { pool: 'CO', count: 31, cap: 30, over_by: 1 },
          ],
        }}
        onDismiss={vi.fn()}
      />,
    );

    const warning = screen.getByTestId('sba-result-overcap');
    expect(warning).toHaveTextContent(/Stake-wide: 351 \/ 350 \(\+1\)/);
    expect(warning).toHaveTextContent(/Ward CO: 31 \/ 30 \(\+1\)/);
  });

  it('does not render the over-cap warning when over_caps is empty or absent', () => {
    const { rerender } = render(
      <ResultDialog state={{ kind: 'ok', note: 'Added.', over_caps: [] }} onDismiss={vi.fn()} />,
    );
    expect(screen.queryByTestId('sba-result-overcap')).not.toBeInTheDocument();

    rerender(<ResultDialog state={{ kind: 'ok', note: 'Added.' }} onDismiss={vi.fn()} />);
    expect(screen.queryByTestId('sba-result-overcap')).not.toBeInTheDocument();
  });

  it('does not render the over-cap warning in partial mode (server never reported it)', () => {
    render(
      <ResultDialog
        state={{
          kind: 'partial',
          note: 'Added.',
          errorMessage: 'SBA down',
          onRetrySba: vi.fn(),
        }}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('sba-result-overcap')).not.toBeInTheDocument();
  });
});
