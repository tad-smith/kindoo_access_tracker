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
          foreignCandidate('east-co', 'East Colorado Stake', 'Foothills Building'),
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
    expect(east).toHaveTextContent('(foreign site: Foothills Building)');
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
          foreignCandidate('east-co', 'East CO', 'Foothills'),
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
          foreignCandidate('east-co', 'East CO', 'Foothills'),
        ]}
        onPick={onPick}
      />,
    );
    await user.click(screen.getByTestId('sba-stake-picker-csnorth'));
    expect(screen.getByTestId('sba-stake-picker-csnorth')).toBeDisabled();
    expect(screen.getByTestId('sba-stake-picker-east-co')).toBeDisabled();
    release?.();
  });
});
