// Component tests for the GrantStakeAccessDialog — the manager-only
// "Give Access To Stake Buildings" modal. Covers:
//   - the license-consumption banner text
//   - scope locked read-only to "Stake"
//   - the building checklist limited to home-site buildings
//   - the add_manual / scope:'stake' submit shape
//   - reason-required + no-buildings-disabled validation

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Building } from '@kindoo/shared';
import { makeSeat } from '../../../../test/fixtures';

const submitMutateAsync = vi.fn().mockResolvedValue({ id: 'req-new' });
const useStakeBuildingsMock = vi.fn();

vi.mock('../hooks', () => ({
  useSubmitRequest: () => ({ mutateAsync: submitMutateAsync, isPending: false }),
  useStakeBuildings: () => useStakeBuildingsMock(),
}));

import { GrantStakeAccessDialog } from './GrantStakeAccessDialog';

const FAKE_TS = { seconds: 0, nanoseconds: 0, toDate: () => new Date(), toMillis: () => 0 };
const FAKE_ACTOR = { email: 'a@b.c', canonical: 'a@b.c' } as const;

function makeBuilding(name: string, kindoo_site_id: string | null): Building {
  return {
    building_id: name.toLowerCase().replace(/\s+/g, '-'),
    building_name: name,
    address: '',
    kindoo_site_id,
    created_at: FAKE_TS,
    last_modified_at: FAKE_TS,
    lastActor: FAKE_ACTOR,
  } as unknown as Building;
}

function liveResult<T>(data: T[]) {
  return {
    data,
    error: null,
    status: 'success' as const,
    isPending: false,
    isLoading: false,
    isSuccess: true,
    isError: false,
    isFetching: false,
    fetchStatus: 'idle' as const,
  };
}

const HOME = makeBuilding('Home Building', null);
const HOME2 = makeBuilding('Stake Center', null);
const FOREIGN = makeBuilding('Foreign Building', 'east-stake');

beforeEach(() => {
  vi.clearAllMocks();
  submitMutateAsync.mockResolvedValue({ id: 'req-new' });
  useStakeBuildingsMock.mockReturnValue(liveResult([HOME, HOME2, FOREIGN]));
});

const SEAT = makeSeat({
  scope: 'FN',
  type: 'manual',
  callings: [],
  member_canonical: 'foreign@x.com',
  member_email: 'foreign@x.com',
  member_name: 'Foreign Member',
});

describe('<GrantStakeAccessDialog />', () => {
  it('renders the exact license-consumption banner at the top', () => {
    render(<GrantStakeAccessDialog seat={SEAT} open onOpenChange={() => {}} />);
    expect(screen.getByTestId('grant-stake-access-banner')).toHaveTextContent(
      'Giving this user access to these buildings will consume an additional Kindoo license.',
    );
  });

  it('shows the scope as a read-only "Stake" value, not a selectable control', () => {
    render(<GrantStakeAccessDialog seat={SEAT} open onOpenChange={() => {}} />);
    const scope = screen.getByTestId('grant-stake-access-scope') as HTMLInputElement;
    expect(scope.value).toBe('Stake');
    expect(scope.readOnly).toBe(true);
    expect(scope.disabled).toBe(true);
  });

  it('limits the building checklist to home-site buildings', () => {
    render(<GrantStakeAccessDialog seat={SEAT} open onOpenChange={() => {}} />);
    expect(screen.getByTestId('grant-stake-access-building-home-building')).toBeInTheDocument();
    expect(screen.getByTestId('grant-stake-access-building-stake-center')).toBeInTheDocument();
    // The foreign-site building is filtered out.
    expect(screen.queryByTestId('grant-stake-access-building-foreign-building')).toBeNull();
  });

  it('disables submit until at least one building is selected', async () => {
    const user = userEvent.setup();
    render(<GrantStakeAccessDialog seat={SEAT} open onOpenChange={() => {}} />);
    expect(screen.getByTestId('grant-stake-access-confirm')).toBeDisabled();
    await user.click(screen.getByTestId('grant-stake-access-building-home-building'));
    expect(screen.getByTestId('grant-stake-access-confirm')).toBeEnabled();
  });

  it('submits an add_manual / scope:"stake" request with the checked buildings + reason + comment', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(<GrantStakeAccessDialog seat={SEAT} open onOpenChange={onOpenChange} />);
    await user.type(screen.getByTestId('grant-stake-access-reason'), 'Stake activities helper');
    await user.type(screen.getByTestId('grant-stake-access-comment'), 'approved by SP');
    await user.click(screen.getByTestId('grant-stake-access-building-home-building'));
    await user.click(screen.getByTestId('grant-stake-access-confirm'));

    await waitFor(() => expect(submitMutateAsync).toHaveBeenCalled());
    const payload = submitMutateAsync.mock.calls[0]![0];
    expect(payload).toMatchObject({
      type: 'add_manual',
      scope: 'stake',
      member_email: 'foreign@x.com',
      member_name: 'Foreign Member',
      reason: 'Stake activities helper',
      comment: 'approved by SP',
      building_names: ['Home Building'],
    });
    // Closes on success.
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it('blocks submit and surfaces a reason error when reason is empty', async () => {
    const user = userEvent.setup();
    render(<GrantStakeAccessDialog seat={SEAT} open onOpenChange={() => {}} />);
    // Select a building so the disabled gate doesn't mask the reason gate.
    await user.click(screen.getByTestId('grant-stake-access-building-home-building'));
    await user.click(screen.getByTestId('grant-stake-access-confirm'));
    expect(await screen.findByTestId('grant-stake-access-reason-error')).toHaveTextContent(
      /reason is required/i,
    );
    expect(submitMutateAsync).not.toHaveBeenCalled();
  });

  it('renders no dialog content when open is false', () => {
    render(<GrantStakeAccessDialog seat={SEAT} open={false} onOpenChange={() => {}} />);
    expect(screen.queryByTestId('grant-stake-access-banner')).toBeNull();
  });
});
