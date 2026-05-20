// Component tests for the stake picker — full-takeover gate rendered
// when an active EID resolves to multiple managed stakes.

import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StakePicker } from './StakePicker';
import type { EidStakeCandidate } from '../lib/messaging';

function homeCandidate(stakeId: string, label: string): EidStakeCandidate {
  return { stakeId, label, match: 'home' };
}

function foreignCandidate(stakeId: string, label: string, siteLabel: string): EidStakeCandidate {
  return { stakeId, label, match: 'foreign', siteLabel };
}

describe('StakePicker', () => {
  it('renders one button per candidate with the stake name + match hint', () => {
    render(
      <StakePicker
        email="mgr@example.com"
        eid={27994}
        candidates={[
          homeCandidate('csnorth', 'Colorado Springs North Stake'),
          foreignCandidate('east-co', 'East Colorado Stake', 'Pine Building'),
        ]}
        onPick={vi.fn()}
      />,
    );
    expect(screen.getByTestId('sba-stake-picker')).toBeInTheDocument();
    expect(screen.getByTestId('sba-stake-picker-eid')).toHaveTextContent('27994');
    const csnorth = screen.getByTestId('sba-stake-picker-csnorth');
    const east = screen.getByTestId('sba-stake-picker-east-co');
    expect(csnorth).toHaveTextContent('Colorado Springs North Stake');
    expect(csnorth).toHaveTextContent('(home site)');
    expect(east).toHaveTextContent('East Colorado Stake');
    expect(east).toHaveTextContent('(foreign site: Pine Building)');
  });

  it('surfaces the signed-in email when one is provided', () => {
    render(
      <StakePicker
        email="mgr@example.com"
        eid={27994}
        candidates={[homeCandidate('csnorth', 'CSN')]}
        onPick={vi.fn()}
      />,
    );
    expect(screen.getByTestId('sba-stake-picker-email')).toHaveTextContent(
      'Signed in as mgr@example.com',
    );
  });

  it('omits the email row when no email is available', () => {
    render(
      <StakePicker
        email={null}
        eid={27994}
        candidates={[homeCandidate('csnorth', 'CSN')]}
        onPick={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('sba-stake-picker-email')).toBeNull();
  });

  it('fires onPick with the chosen stake id on button click', async () => {
    const onPick = vi.fn();
    const user = userEvent.setup();
    render(
      <StakePicker
        email="mgr@example.com"
        eid={27994}
        candidates={[
          homeCandidate('csnorth', 'CSN'),
          foreignCandidate('east-co', 'East CO', 'Pine'),
        ]}
        onPick={onPick}
      />,
    );
    await user.click(screen.getByTestId('sba-stake-picker-east-co'));
    expect(onPick).toHaveBeenCalledWith('east-co');
  });

  it('disables every button while a pick is in flight', async () => {
    let release: (() => void) | undefined;
    const onPick = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const user = userEvent.setup();
    render(
      <StakePicker
        email="mgr@example.com"
        eid={27994}
        candidates={[
          homeCandidate('csnorth', 'CSN'),
          foreignCandidate('east-co', 'East CO', 'Pine'),
        ]}
        onPick={onPick}
      />,
    );
    await user.click(screen.getByTestId('sba-stake-picker-csnorth'));
    expect(screen.getByTestId('sba-stake-picker-csnorth')).toBeDisabled();
    expect(screen.getByTestId('sba-stake-picker-east-co')).toBeDisabled();
    release?.();
  });

  it('renders an inline error banner and re-enables the buttons when onPick rejects (Item 1)', async () => {
    // Item 1: chrome.storage write failure (quota exhausted, etc.)
    // must not silently disappear. The picker surfaces an inline
    // banner above the buttons, re-enables them so a retry is
    // possible, and stays mounted (no auto-resolve).
    const onPick = vi
      .fn()
      .mockRejectedValueOnce(new Error('storage write failed'))
      .mockResolvedValueOnce(undefined);
    const user = userEvent.setup();
    render(
      <StakePicker
        email="mgr@example.com"
        eid={27994}
        candidates={[
          homeCandidate('csnorth', 'CSN'),
          foreignCandidate('east-co', 'East CO', 'Pine'),
        ]}
        onPick={onPick}
      />,
    );
    await user.click(screen.getByTestId('sba-stake-picker-csnorth'));
    // Error banner visible.
    expect(screen.getByTestId('sba-stake-picker-write-error')).toBeInTheDocument();
    expect(screen.getByTestId('sba-stake-picker-write-error')).toHaveTextContent(
      'save your choice',
    );
    // Buttons re-enabled.
    expect(screen.getByTestId('sba-stake-picker-csnorth')).not.toBeDisabled();
    expect(screen.getByTestId('sba-stake-picker-east-co')).not.toBeDisabled();
    // Retrying clears the banner once the next call resolves.
    await user.click(screen.getByTestId('sba-stake-picker-east-co'));
    expect(onPick).toHaveBeenCalledTimes(2);
    expect(onPick).toHaveBeenLastCalledWith('east-co');
  });
});
