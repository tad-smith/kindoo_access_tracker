// Component tests for the EditSeatDialog. The roster-page tests cover
// the affordance gate (which seats render an Edit button); this file
// focuses on the dialog itself:
//
//   - per-sub-type body shape (auto / manual / temp) and field defaults
//   - the auto sub-type's locked-checkbox behaviour for the ward's
//     "Church-managed" template building
//   - submit shape: the dialog forwards the form values into
//     `useSubmitRequest` with the right `type` discriminator and the
//     right field subset per sub-type
//   - inline validation: empty reason / no buildings / end < start
//     block the submit

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Building, Organization, Ward } from '@kindoo/shared';
import { makeSeat, makeWard } from '../../../../test/fixtures';

const submitMutateAsync = vi.fn().mockResolvedValue({ id: 'req-new' });
const useStakeWardsMock = vi.fn();
const useStakeBuildingsMock = vi.fn();

vi.mock('../hooks', () => ({
  useSubmitRequest: () => ({ mutateAsync: submitMutateAsync, isPending: false }),
  useStakeWards: () => useStakeWardsMock(),
  useStakeBuildings: () => useStakeBuildingsMock(),
}));

// The org selector (stake-scope edit_manual / edit_temp) subscribes to
// the organizations catalogue. Override per-test via
// `useOrganizationsMock`; keep the real pure helpers.
const useOrganizationsMock = vi.fn();
vi.mock('../../organizations/hooks', async () => {
  const actual = await vi.importActual<object>('../../organizations/hooks');
  return {
    ...actual,
    useOrganizations: () => useOrganizationsMock(),
  };
});

// The dialog resolves the D25 `limited` flag from the principal + the
// active stake. Both default to a FULL user in `beforeEach`, so every
// pre-existing test in this file keeps its original behaviour; the
// limited-access block at the bottom overrides them.
const usePrincipalMock = vi.fn();
const useActiveStakeMock = vi.fn();
vi.mock('../../../lib/principal', () => ({
  usePrincipal: () => usePrincipalMock(),
}));
vi.mock('../../../lib/useActiveStake', () => ({
  useActiveStake: () => useActiveStakeMock(),
}));

const STAKE_ID = 'csnorth';

function principal(opts: { limited?: boolean } = {}) {
  return {
    isAuthenticated: true,
    firebaseAuthSignedIn: true,
    email: 'bishop@example.com',
    canonical: 'bishop@example.com',
    isPlatformSuperadmin: false,
    managerStakes: [],
    stakeMemberStakes: [],
    bishopricWards: { [STAKE_ID]: ['CO'] },
    limitedStakes: opts.limited ? [STAKE_ID] : [],
    bootstrapStakes: [],
    hasAnyRole: () => true,
    wardsInStake: () => ['CO'],
  };
}

import { EditSeatDialog } from './EditSeatDialog';

const FAKE_TS = { seconds: 0, nanoseconds: 0, toDate: () => new Date(), toMillis: () => 0 };
const FAKE_ACTOR = { email: 'a@b.c', canonical: 'a@b.c' } as const;

function makeBuilding(overrides: Partial<Building> = {}): Building {
  return {
    building_id: 'maple',
    building_name: 'Maple Building',
    address: '',
    created_at: FAKE_TS,
    last_modified_at: FAKE_TS,
    lastActor: FAKE_ACTOR,
    ...overrides,
  };
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

function mockCatalogue(wards: Ward[], buildings: Building[]) {
  useStakeWardsMock.mockReturnValue(liveResult(wards));
  useStakeBuildingsMock.mockReturnValue(liveResult(buildings));
}

function makeOrganization(overrides: Partial<Organization> = {}): Organization {
  return {
    organization_id: 'primary-children',
    name: 'Primary Children',
    seat_cap: 0,
    created_at: FAKE_TS,
    last_modified_at: FAKE_TS,
    lastActor: FAKE_ACTOR,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  submitMutateAsync.mockResolvedValue({ id: 'req-new' });
  useOrganizationsMock.mockReturnValue(liveResult([]));
  usePrincipalMock.mockReturnValue(principal());
  useActiveStakeMock.mockReturnValue(STAKE_ID);
});

describe('<EditSeatDialog /> — edit_auto sub-type', () => {
  it('renders every auto-granted building pre-checked AND disabled; non-granted buildings are unchecked + enabled', () => {
    mockCatalogue(
      [makeWard({ ward_code: 'CO', building_name: 'Maple Building' })],
      [
        makeBuilding({ building_id: 'maple', building_name: 'Maple Building' }),
        makeBuilding({ building_id: 'cedar', building_name: 'Cedar Building' }),
      ],
    );
    const seat = makeSeat({
      type: 'auto',
      scope: 'CO',
      callings: ['Bishop'],
      building_names: ['Maple Building'],
    });
    render(<EditSeatDialog seat={seat} onOpenChange={() => {}} />);
    const mapleCb = screen.getByTestId('edit-seat-building-maple') as HTMLInputElement;
    const cedarCb = screen.getByTestId('edit-seat-building-cedar') as HTMLInputElement;
    expect(mapleCb.checked).toBe(true);
    expect(mapleCb.disabled).toBe(true);
    expect(cedarCb.checked).toBe(false);
    expect(cedarCb.disabled).toBe(false);
    expect(screen.getByTestId('edit-seat-building-locked-maple')).toBeInTheDocument();
  });

  it('locks every building in seat.building_names (not just ward.building_name) — prior edit_auto adds stay locked too', () => {
    // Regression: a previous interpretation locked only the ward's
    // template building, which left "operator-added extras from a prior
    // edit_auto" as uncheckable. The locked set is now seat.building_names
    // in full so the user can never silently remove an existing grant
    // through this dialog.
    mockCatalogue(
      [makeWard({ ward_code: 'CO', building_name: 'Maple Building' })],
      [
        makeBuilding({ building_id: 'maple', building_name: 'Maple Building' }),
        makeBuilding({ building_id: 'cedar', building_name: 'Cedar Building' }),
        makeBuilding({ building_id: 'prairie', building_name: 'Prairie Building' }),
      ],
    );
    const seat = makeSeat({
      type: 'auto',
      scope: 'CO',
      callings: ['Bishop'],
      building_names: ['Maple Building', 'Cedar Building'],
    });
    render(<EditSeatDialog seat={seat} onOpenChange={() => {}} />);
    const mapleCb = screen.getByTestId('edit-seat-building-maple') as HTMLInputElement;
    const cedarCb = screen.getByTestId('edit-seat-building-cedar') as HTMLInputElement;
    const prairieCb = screen.getByTestId('edit-seat-building-prairie') as HTMLInputElement;
    expect(mapleCb.checked).toBe(true);
    expect(mapleCb.disabled).toBe(true);
    expect(cedarCb.checked).toBe(true);
    expect(cedarCb.disabled).toBe(true);
    expect(prairieCb.checked).toBe(false);
    expect(prairieCb.disabled).toBe(false);
  });

  it('locks same-scope non-auto DuplicateGrant buildings alongside the auto-primary set (collapsed-row buildings stay locked)', () => {
    // After PR #166, AllSeats / rosters collapse a same-scope non-auto
    // DuplicateGrant into the auto-primary row; the displayed buildings
    // are the union. The edit dialog mirrors that union into the VISUAL
    // lock so the user cannot silently uncheck a dup building (an
    // edit_auto submission wouldn't touch the dup; the change would
    // no-op silently). Manual dups and temp dups both qualify.
    mockCatalogue(
      [makeWard({ ward_code: 'CO', building_name: 'Maple Building' })],
      [
        makeBuilding({ building_id: 'maple', building_name: 'Maple Building' }),
        makeBuilding({ building_id: 'cedar', building_name: 'Cedar Building' }),
        makeBuilding({ building_id: 'prairie', building_name: 'Prairie Building' }),
      ],
    );
    const seat = makeSeat({
      type: 'auto',
      scope: 'CO',
      callings: ['Bishop'],
      building_names: ['Maple Building'],
      duplicate_grants: [
        {
          scope: 'CO',
          type: 'manual',
          building_names: ['Cedar Building'],
          detected_at: FAKE_TS,
        },
      ],
    });
    render(<EditSeatDialog seat={seat} onOpenChange={() => {}} />);
    const mapleCb = screen.getByTestId('edit-seat-building-maple') as HTMLInputElement;
    const cedarCb = screen.getByTestId('edit-seat-building-cedar') as HTMLInputElement;
    const prairieCb = screen.getByTestId('edit-seat-building-prairie') as HTMLInputElement;
    expect(mapleCb.checked).toBe(true);
    expect(mapleCb.disabled).toBe(true);
    expect(cedarCb.checked).toBe(true);
    expect(cedarCb.disabled).toBe(true);
    expect(prairieCb.checked).toBe(false);
    expect(prairieCb.disabled).toBe(false);
  });

  it('locks same-scope temp DuplicateGrant buildings the same as manual dups (collapsed-row honesty)', () => {
    // Symmetric with the manual-dup case above. A same-scope temp
    // DuplicateGrant also collapses into the displayed row on
    // AllSeats / rosters, so the dialog must lock its buildings too —
    // an edit_auto submit cannot prune them (the request type doesn't
    // touch DuplicateGrants), so allowing the user to uncheck would
    // no-op silently.
    mockCatalogue(
      [makeWard({ ward_code: 'CO', building_name: 'Maple Building' })],
      [
        makeBuilding({ building_id: 'maple', building_name: 'Maple Building' }),
        makeBuilding({ building_id: 'cedar', building_name: 'Cedar Building' }),
      ],
    );
    const seat = makeSeat({
      type: 'auto',
      scope: 'CO',
      callings: ['Bishop'],
      building_names: ['Maple Building'],
      duplicate_grants: [
        {
          scope: 'CO',
          type: 'temp',
          building_names: ['Cedar Building'],
          start_date: '2026-06-01',
          end_date: '2026-06-15',
          detected_at: FAKE_TS,
        },
      ],
    });
    render(<EditSeatDialog seat={seat} onOpenChange={() => {}} />);
    const mapleCb = screen.getByTestId('edit-seat-building-maple') as HTMLInputElement;
    const cedarCb = screen.getByTestId('edit-seat-building-cedar') as HTMLInputElement;
    expect(mapleCb.checked).toBe(true);
    expect(mapleCb.disabled).toBe(true);
    expect(cedarCb.checked).toBe(true);
    expect(cedarCb.disabled).toBe(true);
  });

  it('excludes same-scope non-auto DuplicateGrant buildings from the submit body even though they render locked (no-op submit, no data corruption)', async () => {
    // Load-bearing regression. The visual lock and the submit-body
    // are intentionally split:
    //   - VISUAL: auto-primary `building_names` ∪ same-scope non-auto
    //     dup `building_names` — render all of them checked + disabled
    //     so the operator sees what they see on the collapsed roster
    //     row.
    //   - SUBMIT: ONLY the auto-primary `building_names`. The
    //     `edit_auto` request type replaces the auto-primary's
    //     `building_names` and DOES NOT touch the dup. Conflating
    //     dup buildings into the submit would absorb them onto the
    //     auto-primary slot while the dup remained in place —
    //     double-credit on display, double-provision on Kindoo. The
    //     user just submits with no checkbox changes; the wire body
    //     must be ['Maple Building'], NOT
    //     ['Maple Building', 'Cedar Building'].
    const user = userEvent.setup();
    mockCatalogue(
      [makeWard({ ward_code: 'CO', building_name: 'Maple Building' })],
      [
        makeBuilding({ building_id: 'maple', building_name: 'Maple Building' }),
        makeBuilding({ building_id: 'cedar', building_name: 'Cedar Building' }),
      ],
    );
    const seat = makeSeat({
      type: 'auto',
      scope: 'CO',
      callings: ['Bishop'],
      building_names: ['Maple Building'],
      duplicate_grants: [
        {
          scope: 'CO',
          type: 'manual',
          building_names: ['Cedar Building'],
          detected_at: FAKE_TS,
        },
      ],
    });
    render(<EditSeatDialog seat={seat} onOpenChange={() => {}} />);
    await user.type(screen.getByTestId('edit-seat-comment'), 'note');
    await user.click(screen.getByTestId('edit-seat-confirm'));
    await waitFor(() => expect(submitMutateAsync).toHaveBeenCalledTimes(1));
    const arg = submitMutateAsync.mock.calls[0]?.[0] as Record<string, unknown> & {
      building_names: string[];
    };
    expect(arg.type).toBe('edit_auto');
    expect(arg.building_names).toEqual(['Maple Building']);
    // Explicit defense — the dup-only building must NOT appear in the
    // submit body.
    expect(arg.building_names).not.toContain('Cedar Building');
  });

  it('with a non-auto dup present, adding a new building submits [auto-primary..., new-building] — dup buildings still excluded', async () => {
    // Same separation as above, exercising the add path. The operator
    // ticks Prairie Building (not part of either the auto-primary set
    // or the dup). The submit body must include the auto-primary + the
    // new add, and MUST NOT include the dup building even though it
    // renders visually checked.
    const user = userEvent.setup();
    mockCatalogue(
      [makeWard({ ward_code: 'CO', building_name: 'Maple Building' })],
      [
        makeBuilding({ building_id: 'maple', building_name: 'Maple Building' }),
        makeBuilding({ building_id: 'cedar', building_name: 'Cedar Building' }),
        makeBuilding({ building_id: 'prairie', building_name: 'Prairie Building' }),
      ],
    );
    const seat = makeSeat({
      type: 'auto',
      scope: 'CO',
      callings: ['Bishop'],
      building_names: ['Maple Building'],
      duplicate_grants: [
        {
          scope: 'CO',
          type: 'manual',
          building_names: ['Cedar Building'],
          detected_at: FAKE_TS,
        },
      ],
    });
    render(<EditSeatDialog seat={seat} onOpenChange={() => {}} />);
    await user.click(screen.getByTestId('edit-seat-building-prairie'));
    await user.type(screen.getByTestId('edit-seat-comment'), 'note');
    await user.click(screen.getByTestId('edit-seat-confirm'));
    await waitFor(() => expect(submitMutateAsync).toHaveBeenCalledTimes(1));
    const arg = submitMutateAsync.mock.calls[0]?.[0] as Record<string, unknown> & {
      building_names: string[];
    };
    expect(arg.type).toBe('edit_auto');
    expect([...arg.building_names].sort()).toEqual(['Maple Building', 'Prairie Building']);
    expect(arg.building_names).not.toContain('Cedar Building');
  });

  it('surfaces a tooltip on each disabled (locked) checkbox explaining why it cannot be unchecked', () => {
    mockCatalogue(
      [makeWard({ ward_code: 'CO', building_name: 'Maple Building' })],
      [makeBuilding({ building_id: 'maple', building_name: 'Maple Building' })],
    );
    const seat = makeSeat({
      type: 'auto',
      scope: 'CO',
      callings: ['Bishop'],
      building_names: ['Maple Building'],
    });
    render(<EditSeatDialog seat={seat} onOpenChange={() => {}} />);
    const mapleCb = screen.getByTestId('edit-seat-building-maple') as HTMLInputElement;
    // The title attribute is what the browser surfaces as a tooltip on
    // hover; for the disabled checkbox the same title goes on the
    // wrapping label too so the hover surface includes the text label.
    expect(mapleCb.getAttribute('title')).toMatch(/already granted/i);
  });

  it('omits the Calling / Reason field on edit_auto', () => {
    mockCatalogue(
      [makeWard({ ward_code: 'CO', building_name: 'Maple Building' })],
      [makeBuilding()],
    );
    const seat = makeSeat({
      type: 'auto',
      scope: 'CO',
      callings: ['Bishop'],
      building_names: ['Maple Building'],
    });
    render(<EditSeatDialog seat={seat} onOpenChange={() => {}} />);
    expect(screen.queryByTestId('edit-seat-reason')).toBeNull();
  });

  it('submits an edit_auto request whose building_names union includes the locked template building plus operator additions', async () => {
    const user = userEvent.setup();
    mockCatalogue(
      [makeWard({ ward_code: 'CO', building_name: 'Maple Building' })],
      [
        makeBuilding({ building_id: 'maple', building_name: 'Maple Building' }),
        makeBuilding({ building_id: 'cedar', building_name: 'Cedar Building' }),
      ],
    );
    const seat = makeSeat({
      type: 'auto',
      scope: 'CO',
      member_email: 'auto@x.com',
      member_canonical: 'auto@x.com',
      member_name: 'Auto Person',
      callings: ['Bishop'],
      building_names: ['Maple Building'],
    });
    render(<EditSeatDialog seat={seat} onOpenChange={() => {}} />);
    await user.click(screen.getByTestId('edit-seat-building-cedar'));
    await user.type(screen.getByTestId('edit-seat-comment'), 'note');
    await user.click(screen.getByTestId('edit-seat-confirm'));
    await waitFor(() => expect(submitMutateAsync).toHaveBeenCalledTimes(1));
    const arg = submitMutateAsync.mock.calls[0]?.[0] as Record<string, unknown> & {
      building_names: string[];
    };
    expect(arg.type).toBe('edit_auto');
    expect(arg.scope).toBe('CO');
    expect(arg.member_email).toBe('auto@x.com');
    expect(arg.member_name).toBe('Auto Person');
    expect([...arg.building_names].sort()).toEqual(['Cedar Building', 'Maple Building']);
    expect(arg.comment).toBe('note');
    // No dates on edit_auto.
    expect(arg.start_date).toBeUndefined();
    expect(arg.end_date).toBeUndefined();
  });

  it('renders a required Comment field in the dialog body', () => {
    mockCatalogue(
      [makeWard({ ward_code: 'CO', building_name: 'Maple Building' })],
      [makeBuilding({ building_id: 'maple', building_name: 'Maple Building' })],
    );
    const seat = makeSeat({
      type: 'auto',
      scope: 'CO',
      callings: ['Bishop'],
      building_names: ['Maple Building'],
    });
    render(<EditSeatDialog seat={seat} onOpenChange={() => {}} />);
    expect(screen.getByTestId('edit-seat-comment')).toBeInTheDocument();
    expect(screen.getByTestId('edit-seat-comment-marker').textContent).toMatch(/required/i);
  });

  it('blocks submit with an inline error when comment is empty', async () => {
    const user = userEvent.setup();
    mockCatalogue(
      [makeWard({ ward_code: 'CO', building_name: 'Maple Building' })],
      [makeBuilding({ building_id: 'maple', building_name: 'Maple Building' })],
    );
    const seat = makeSeat({
      type: 'auto',
      scope: 'CO',
      callings: ['Bishop'],
      building_names: ['Maple Building'],
    });
    render(<EditSeatDialog seat={seat} onOpenChange={() => {}} />);
    await user.click(screen.getByTestId('edit-seat-confirm'));
    expect(submitMutateAsync).not.toHaveBeenCalled();
    expect(screen.getByTestId('edit-seat-comment-error')).toBeInTheDocument();
  });

  it('blocks submit with an inline error when comment is whitespace-only', async () => {
    const user = userEvent.setup();
    mockCatalogue(
      [makeWard({ ward_code: 'CO', building_name: 'Maple Building' })],
      [makeBuilding({ building_id: 'maple', building_name: 'Maple Building' })],
    );
    const seat = makeSeat({
      type: 'auto',
      scope: 'CO',
      callings: ['Bishop'],
      building_names: ['Maple Building'],
    });
    render(<EditSeatDialog seat={seat} onOpenChange={() => {}} />);
    await user.type(screen.getByTestId('edit-seat-comment'), '   ');
    await user.click(screen.getByTestId('edit-seat-confirm'));
    expect(submitMutateAsync).not.toHaveBeenCalled();
    expect(screen.getByTestId('edit-seat-comment-error')).toBeInTheDocument();
  });
});

describe('<EditSeatDialog /> — edit_manual sub-type', () => {
  it('pre-fills the reason field and the building checklist from the seat', () => {
    mockCatalogue(
      [makeWard({ ward_code: 'CO' })],
      [
        makeBuilding({ building_id: 'maple', building_name: 'Maple Building' }),
        makeBuilding({ building_id: 'cedar', building_name: 'Cedar Building' }),
      ],
    );
    const seat = makeSeat({
      type: 'manual',
      scope: 'CO',
      callings: [],
      reason: 'sub teacher',
      building_names: ['Maple Building'],
    });
    render(<EditSeatDialog seat={seat} onOpenChange={() => {}} />);
    const mapleCb = screen.getByTestId('edit-seat-building-maple') as HTMLInputElement;
    const cedarCb = screen.getByTestId('edit-seat-building-cedar') as HTMLInputElement;
    expect(mapleCb.checked).toBe(true);
    expect(mapleCb.disabled).toBe(false);
    expect(cedarCb.checked).toBe(false);
    // CallingCombobox puts data-testid directly on the underlying input.
    const reasonInput = screen.getByTestId('edit-seat-reason') as HTMLInputElement;
    expect(reasonInput.tagName.toLowerCase()).toBe('input');
    expect(reasonInput.value).toBe('sub teacher');
  });

  it('submits an edit_manual request with the operator-typed reason + checked buildings', async () => {
    const user = userEvent.setup();
    mockCatalogue(
      [makeWard({ ward_code: 'CO' })],
      [
        makeBuilding({ building_id: 'maple', building_name: 'Maple Building' }),
        makeBuilding({ building_id: 'cedar', building_name: 'Cedar Building' }),
      ],
    );
    const seat = makeSeat({
      type: 'manual',
      scope: 'CO',
      member_email: 'manual@x.com',
      member_canonical: 'manual@x.com',
      member_name: 'Manual Person',
      callings: [],
      reason: 'sub teacher',
      building_names: ['Maple Building'],
    });
    render(<EditSeatDialog seat={seat} onOpenChange={() => {}} />);
    // Add the second building.
    await user.click(screen.getByTestId('edit-seat-building-cedar'));
    await user.type(screen.getByTestId('edit-seat-comment'), 'note');
    await user.click(screen.getByTestId('edit-seat-confirm'));
    await waitFor(() => expect(submitMutateAsync).toHaveBeenCalledTimes(1));
    const arg = submitMutateAsync.mock.calls[0]?.[0] as Record<string, unknown> & {
      building_names: string[];
    };
    expect(arg.type).toBe('edit_manual');
    expect(arg.reason).toBe('sub teacher');
    expect([...arg.building_names].sort()).toEqual(['Cedar Building', 'Maple Building']);
    expect(arg.comment).toBe('note');
    expect(arg.start_date).toBeUndefined();
    expect(arg.end_date).toBeUndefined();
  });

  it('blocks submission (button disabled) when no buildings are checked', async () => {
    // Matches the NewRequestForm gate — every `edit_*` / `add_*` request
    // must carry ≥ 1 building (operator decision 2026-05-16, spec §5.1
    // / §6). Submit is disabled while the building checklist is empty;
    // the schema layer is the second defense.
    const user = userEvent.setup();
    mockCatalogue(
      [makeWard({ ward_code: 'CO' })],
      [makeBuilding({ building_id: 'maple', building_name: 'Maple Building' })],
    );
    const seat = makeSeat({
      type: 'manual',
      scope: 'CO',
      callings: [],
      reason: 'sub teacher',
      building_names: [],
    });
    render(<EditSeatDialog seat={seat} onOpenChange={() => {}} />);
    await user.type(screen.getByTestId('edit-seat-comment'), 'note');
    const confirmBtn = screen.getByTestId('edit-seat-confirm');
    expect(confirmBtn).toBeDisabled();
    await user.click(confirmBtn);
    expect(submitMutateAsync).not.toHaveBeenCalled();
  });

  it('renders a required Comment field in the dialog body', () => {
    mockCatalogue(
      [makeWard({ ward_code: 'CO' })],
      [makeBuilding({ building_id: 'maple', building_name: 'Maple Building' })],
    );
    const seat = makeSeat({
      type: 'manual',
      scope: 'CO',
      callings: [],
      reason: 'sub teacher',
      building_names: ['Maple Building'],
    });
    render(<EditSeatDialog seat={seat} onOpenChange={() => {}} />);
    expect(screen.getByTestId('edit-seat-comment')).toBeInTheDocument();
    expect(screen.getByTestId('edit-seat-comment-marker').textContent).toMatch(/required/i);
  });

  it('blocks submit with an inline error when comment is empty', async () => {
    const user = userEvent.setup();
    mockCatalogue(
      [makeWard({ ward_code: 'CO' })],
      [makeBuilding({ building_id: 'maple', building_name: 'Maple Building' })],
    );
    const seat = makeSeat({
      type: 'manual',
      scope: 'CO',
      callings: [],
      reason: 'sub teacher',
      building_names: ['Maple Building'],
    });
    render(<EditSeatDialog seat={seat} onOpenChange={() => {}} />);
    await user.click(screen.getByTestId('edit-seat-confirm'));
    expect(submitMutateAsync).not.toHaveBeenCalled();
    expect(screen.getByTestId('edit-seat-comment-error')).toBeInTheDocument();
  });

  it('blocks submit with an inline error when comment is whitespace-only', async () => {
    const user = userEvent.setup();
    mockCatalogue(
      [makeWard({ ward_code: 'CO' })],
      [makeBuilding({ building_id: 'maple', building_name: 'Maple Building' })],
    );
    const seat = makeSeat({
      type: 'manual',
      scope: 'CO',
      callings: [],
      reason: 'sub teacher',
      building_names: ['Maple Building'],
    });
    render(<EditSeatDialog seat={seat} onOpenChange={() => {}} />);
    await user.type(screen.getByTestId('edit-seat-comment'), '   ');
    await user.click(screen.getByTestId('edit-seat-confirm'));
    expect(submitMutateAsync).not.toHaveBeenCalled();
    expect(screen.getByTestId('edit-seat-comment-error')).toBeInTheDocument();
  });
});

describe('<EditSeatDialog /> — edit_temp sub-type', () => {
  it('renders date pickers pre-populated from the seat and a plain-text reason (no typeahead)', () => {
    mockCatalogue(
      [makeWard({ ward_code: 'CO' })],
      [makeBuilding({ building_id: 'maple', building_name: 'Maple Building' })],
    );
    const seat = makeSeat({
      type: 'temp',
      scope: 'CO',
      callings: [],
      reason: 'youth conference',
      building_names: ['Maple Building'],
      start_date: '2026-05-01',
      end_date: '2026-05-08',
    });
    render(<EditSeatDialog seat={seat} onOpenChange={() => {}} />);
    const start = screen.getByTestId('edit-seat-start-date') as HTMLInputElement;
    const end = screen.getByTestId('edit-seat-end-date') as HTMLInputElement;
    expect(start.value).toBe('2026-05-01');
    expect(end.value).toBe('2026-05-08');
    // edit_temp uses a plain <Input type="text"> for reason — no combobox.
    const reasonField = screen.getByTestId('edit-seat-reason') as HTMLInputElement;
    expect(reasonField.tagName.toLowerCase()).toBe('input');
    expect(reasonField.value).toBe('youth conference');
  });

  it('submits an edit_temp request carrying reason + buildings + the full date pair', async () => {
    const user = userEvent.setup();
    mockCatalogue(
      [makeWard({ ward_code: 'CO' })],
      [makeBuilding({ building_id: 'maple', building_name: 'Maple Building' })],
    );
    const seat = makeSeat({
      type: 'temp',
      scope: 'CO',
      member_email: 'temp@x.com',
      member_canonical: 'temp@x.com',
      member_name: 'Temp Person',
      callings: [],
      reason: 'youth conference',
      building_names: ['Maple Building'],
      start_date: '2026-05-01',
      end_date: '2026-05-08',
    });
    render(<EditSeatDialog seat={seat} onOpenChange={() => {}} />);
    const end = screen.getByTestId('edit-seat-end-date') as HTMLInputElement;
    await user.clear(end);
    await user.type(end, '2026-05-15');
    await user.type(screen.getByTestId('edit-seat-comment'), 'note');
    await user.click(screen.getByTestId('edit-seat-confirm'));
    await waitFor(() => expect(submitMutateAsync).toHaveBeenCalledTimes(1));
    const arg = submitMutateAsync.mock.calls[0]?.[0] as Record<string, unknown> & {
      building_names: string[];
    };
    expect(arg.type).toBe('edit_temp');
    expect(arg.reason).toBe('youth conference');
    expect(arg.building_names).toEqual(['Maple Building']);
    expect(arg.comment).toBe('note');
    expect(arg.start_date).toBe('2026-05-01');
    expect(arg.end_date).toBe('2026-05-15');
  });

  it('blocks submission when end_date precedes start_date', async () => {
    const user = userEvent.setup();
    mockCatalogue(
      [makeWard({ ward_code: 'CO' })],
      [makeBuilding({ building_id: 'maple', building_name: 'Maple Building' })],
    );
    const seat = makeSeat({
      type: 'temp',
      scope: 'CO',
      callings: [],
      reason: 'youth conference',
      building_names: ['Maple Building'],
      start_date: '2026-05-08',
      end_date: '2026-05-01',
    });
    render(<EditSeatDialog seat={seat} onOpenChange={() => {}} />);
    await user.type(screen.getByTestId('edit-seat-comment'), 'note');
    await user.click(screen.getByTestId('edit-seat-confirm'));
    expect(submitMutateAsync).not.toHaveBeenCalled();
    expect(screen.getByText(/end date must be on or after the start date/i)).toBeInTheDocument();
  });

  it('blocks submission with an inline error when the reason is whitespace-only', async () => {
    const user = userEvent.setup();
    mockCatalogue(
      [makeWard({ ward_code: 'CO' })],
      [makeBuilding({ building_id: 'maple', building_name: 'Maple Building' })],
    );
    const seat = makeSeat({
      type: 'temp',
      scope: 'CO',
      callings: [],
      reason: '',
      building_names: ['Maple Building'],
      start_date: '2026-05-01',
      end_date: '2026-05-08',
    });
    render(<EditSeatDialog seat={seat} onOpenChange={() => {}} />);
    await user.type(screen.getByTestId('edit-seat-comment'), 'note');
    await user.click(screen.getByTestId('edit-seat-confirm'));
    expect(submitMutateAsync).not.toHaveBeenCalled();
    expect(screen.getByText(/reason is required/i)).toBeInTheDocument();
  });

  it('renders a required Comment field in the dialog body', () => {
    mockCatalogue(
      [makeWard({ ward_code: 'CO' })],
      [makeBuilding({ building_id: 'maple', building_name: 'Maple Building' })],
    );
    const seat = makeSeat({
      type: 'temp',
      scope: 'CO',
      callings: [],
      reason: 'youth conference',
      building_names: ['Maple Building'],
      start_date: '2026-05-01',
      end_date: '2026-05-08',
    });
    render(<EditSeatDialog seat={seat} onOpenChange={() => {}} />);
    expect(screen.getByTestId('edit-seat-comment')).toBeInTheDocument();
    expect(screen.getByTestId('edit-seat-comment-marker').textContent).toMatch(/required/i);
  });

  it('blocks submit with an inline error when comment is empty', async () => {
    const user = userEvent.setup();
    mockCatalogue(
      [makeWard({ ward_code: 'CO' })],
      [makeBuilding({ building_id: 'maple', building_name: 'Maple Building' })],
    );
    const seat = makeSeat({
      type: 'temp',
      scope: 'CO',
      callings: [],
      reason: 'youth conference',
      building_names: ['Maple Building'],
      start_date: '2026-05-01',
      end_date: '2026-05-08',
    });
    render(<EditSeatDialog seat={seat} onOpenChange={() => {}} />);
    await user.click(screen.getByTestId('edit-seat-confirm'));
    expect(submitMutateAsync).not.toHaveBeenCalled();
    expect(screen.getByTestId('edit-seat-comment-error')).toBeInTheDocument();
  });

  it('blocks submit with an inline error when comment is whitespace-only', async () => {
    const user = userEvent.setup();
    mockCatalogue(
      [makeWard({ ward_code: 'CO' })],
      [makeBuilding({ building_id: 'maple', building_name: 'Maple Building' })],
    );
    const seat = makeSeat({
      type: 'temp',
      scope: 'CO',
      callings: [],
      reason: 'youth conference',
      building_names: ['Maple Building'],
      start_date: '2026-05-01',
      end_date: '2026-05-08',
    });
    render(<EditSeatDialog seat={seat} onOpenChange={() => {}} />);
    await user.type(screen.getByTestId('edit-seat-comment'), '   ');
    await user.click(screen.getByTestId('edit-seat-confirm'));
    expect(submitMutateAsync).not.toHaveBeenCalled();
    expect(screen.getByTestId('edit-seat-comment-error')).toBeInTheDocument();
  });
});

describe('<EditSeatDialog /> — Kindoo Sites building filter (spec §15)', () => {
  // Phase 2 narrows the Edit Seat dialog's building checklist to the
  // seat's scope's Kindoo site. Foreign-site ward seats see foreign
  // buildings only; home ward seats (and stake-scope seats) see home
  // buildings only. Pre-checked seat building_names outside the visible
  // set are dropped from the form defaults so the user can only check
  // / uncheck what they can see (Risk 2 — invisible home pre-check on
  // a legacy ward where ward.building_name disagrees with ward.kindoo_site_id).

  it('shows ONLY foreign-site buildings on a foreign-site ward seat', () => {
    mockCatalogue(
      // The ward's site is derived from its building (Pine → foreign-1).
      [makeWard({ ward_code: 'FN', building_name: 'Pine Building' })],
      [
        makeBuilding({
          building_id: 'maple',
          building_name: 'Maple Building',
          kindoo_site_id: null,
        }),
        makeBuilding({
          building_id: 'pine',
          building_name: 'Pine Building',
          kindoo_site_id: 'foreign-1',
        }),
      ],
    );
    const seat = makeSeat({
      type: 'manual',
      scope: 'FN',
      callings: [],
      reason: 'sub teacher',
      building_names: ['Pine Building'],
    });
    render(<EditSeatDialog seat={seat} onOpenChange={() => {}} />);
    expect(screen.getByTestId('edit-seat-building-pine')).toBeInTheDocument();
    expect(screen.queryByTestId('edit-seat-building-maple')).toBeNull();
  });

  it('shows ONLY home-site buildings on a home ward seat', () => {
    mockCatalogue(
      [makeWard({ ward_code: 'CO', building_name: 'Maple Building' })],
      [
        makeBuilding({
          building_id: 'maple',
          building_name: 'Maple Building',
          kindoo_site_id: null,
        }),
        makeBuilding({
          building_id: 'pine',
          building_name: 'Pine Building',
          kindoo_site_id: 'foreign-1',
        }),
      ],
    );
    const seat = makeSeat({
      type: 'manual',
      scope: 'CO',
      callings: [],
      reason: 'sub teacher',
      building_names: ['Maple Building'],
    });
    render(<EditSeatDialog seat={seat} onOpenChange={() => {}} />);
    expect(screen.getByTestId('edit-seat-building-maple')).toBeInTheDocument();
    expect(screen.queryByTestId('edit-seat-building-pine')).toBeNull();
  });

  it('drops a seat building_name outside the visible set from the form defaults (Risk 2 clamp)', () => {
    // Ward FN is foreign-1; seat's `building_names` carries a stale
    // home building ('Maple Building'). The home building is hidden
    // by the site filter; the form must NOT pre-check it (which would
    // be invisible and impossible to uncheck) and must NOT ship it on
    // submit. With no foreign building also ticked, the dialog renders
    // zero pre-checked checkboxes.
    mockCatalogue(
      // Ward FN's building (Pine) is on foreign-1; site derives from it.
      [makeWard({ ward_code: 'FN', building_name: 'Pine Building' })],
      [
        makeBuilding({
          building_id: 'maple',
          building_name: 'Maple Building',
          kindoo_site_id: null,
        }),
        makeBuilding({
          building_id: 'pine',
          building_name: 'Pine Building',
          kindoo_site_id: 'foreign-1',
        }),
      ],
    );
    const seat = makeSeat({
      type: 'manual',
      scope: 'FN',
      callings: [],
      reason: 'sub teacher',
      // Stale home building only — nothing in the foreign-1 set.
      building_names: ['Maple Building'],
    });
    render(<EditSeatDialog seat={seat} onOpenChange={() => {}} />);
    // Hidden home building's checkbox is not rendered at all.
    expect(screen.queryByTestId('edit-seat-building-maple')).toBeNull();
    // Visible foreign building is rendered but NOT pre-checked.
    expect(screen.getByTestId('edit-seat-building-pine')).not.toBeChecked();
  });

  it('renders an empty-state when the site filter narrows the catalogue to zero', () => {
    // Ward FN resolves to the home site (its building isn't in the
    // catalogue), but no home building is configured yet — only a
    // foreign one. The home-filtered visible set is empty, so the
    // dialog renders an explicit message rather than an empty list.
    mockCatalogue(
      [makeWard({ ward_code: 'FN', building_name: '' })],
      [
        makeBuilding({
          building_id: 'pine',
          building_name: 'Pine Building',
          kindoo_site_id: 'foreign-1',
        }),
      ],
    );
    const seat = makeSeat({
      type: 'manual',
      scope: 'FN',
      callings: [],
      reason: 'sub teacher',
      building_names: [],
    });
    render(<EditSeatDialog seat={seat} onOpenChange={() => {}} />);
    expect(screen.getByTestId('edit-seat-buildings-empty-for-scope')).toBeInTheDocument();
    expect(screen.queryByTestId('edit-seat-building-pine')).toBeNull();
  });
});

describe('<EditSeatDialog /> — dialog lifecycle', () => {
  it('closes via onOpenChange(false) after a successful submit', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    mockCatalogue(
      [makeWard({ ward_code: 'CO' })],
      [makeBuilding({ building_id: 'maple', building_name: 'Maple Building' })],
    );
    const seat = makeSeat({
      type: 'manual',
      scope: 'CO',
      callings: [],
      reason: 'sub teacher',
      building_names: ['Maple Building'],
    });
    render(<EditSeatDialog seat={seat} onOpenChange={onOpenChange} />);
    await user.type(screen.getByTestId('edit-seat-comment'), 'note');
    await user.click(screen.getByTestId('edit-seat-confirm'));
    await waitFor(() => expect(submitMutateAsync).toHaveBeenCalledTimes(1));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('renders nothing when seat is null', () => {
    mockCatalogue([], []);
    const { container } = render(<EditSeatDialog seat={null} onOpenChange={() => {}} />);
    expect(container.querySelector('[data-testid="edit-seat-dialog-form"]')).toBeNull();
  });
});

describe('<EditSeatDialog /> — organization selector (stake scope only)', () => {
  it('does not render the org selector for a ward-scope manual seat', () => {
    mockCatalogue(
      [makeWard({ ward_code: 'CO', building_name: 'Maple Building' })],
      [makeBuilding({ building_id: 'maple', building_name: 'Maple Building' })],
    );
    useOrganizationsMock.mockReturnValue(liveResult([makeOrganization()]));
    const seat = makeSeat({
      type: 'manual',
      scope: 'CO',
      callings: [],
      reason: 'sub teacher',
      building_names: ['Maple Building'],
    });
    render(<EditSeatDialog seat={seat} onOpenChange={() => {}} />);
    expect(screen.queryByTestId('edit-seat-organization')).toBeNull();
  });

  it('renders the org selector for a stake-scope manual seat, defaulting to "No Organization"', () => {
    mockCatalogue([], [makeBuilding({ building_id: 'maple', building_name: 'Maple Building' })]);
    useOrganizationsMock.mockReturnValue(
      liveResult([
        makeOrganization({ organization_id: 'scouts', name: 'Scouts' }),
        makeOrganization({ organization_id: 'primary-children', name: 'Primary Children' }),
      ]),
    );
    const seat = makeSeat({
      type: 'manual',
      scope: 'stake',
      callings: [],
      reason: 'sub teacher',
      building_names: ['Maple Building'],
    });
    render(<EditSeatDialog seat={seat} onOpenChange={() => {}} />);
    const select = screen.getByTestId('edit-seat-organization') as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.text)).toEqual([
      'No Organization',
      'Primary Children',
      'Scouts',
    ]);
    expect(select.options[select.selectedIndex]!.text).toBe('No Organization');
  });

  it('pre-fills the org selector from the seat.organization_id', () => {
    mockCatalogue([], [makeBuilding({ building_id: 'maple', building_name: 'Maple Building' })]);
    useOrganizationsMock.mockReturnValue(
      liveResult([makeOrganization({ organization_id: 'scouts', name: 'Scouts' })]),
    );
    const seat = makeSeat({
      type: 'manual',
      scope: 'stake',
      callings: [],
      reason: 'sub teacher',
      building_names: ['Maple Building'],
      organization_id: 'scouts',
    });
    render(<EditSeatDialog seat={seat} onOpenChange={() => {}} />);
    const select = screen.getByTestId('edit-seat-organization') as HTMLSelectElement;
    expect(select.value).toBe('scouts');
  });

  it('submits the chosen organization_id for a stake-scope edit_manual request', async () => {
    const user = userEvent.setup();
    mockCatalogue([], [makeBuilding({ building_id: 'maple', building_name: 'Maple Building' })]);
    useOrganizationsMock.mockReturnValue(
      liveResult([
        makeOrganization({ organization_id: 'scouts', name: 'Scouts' }),
        makeOrganization({ organization_id: 'primary-children', name: 'Primary Children' }),
      ]),
    );
    const seat = makeSeat({
      type: 'manual',
      scope: 'stake',
      callings: [],
      reason: 'sub teacher',
      building_names: ['Maple Building'],
      organization_id: 'scouts',
    });
    render(<EditSeatDialog seat={seat} onOpenChange={() => {}} />);
    await user.selectOptions(screen.getByTestId('edit-seat-organization'), 'primary-children');
    await user.type(screen.getByTestId('edit-seat-comment'), 'note');
    await user.click(screen.getByTestId('edit-seat-confirm'));
    await waitFor(() => expect(submitMutateAsync).toHaveBeenCalledTimes(1));
    const arg = submitMutateAsync.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(arg.type).toBe('edit_manual');
    expect(arg.scope).toBe('stake');
    expect(arg.organization_id).toBe('primary-children');
  });

  it('submits organization_id=null when "No Organization" is chosen on a stake seat', async () => {
    const user = userEvent.setup();
    mockCatalogue([], [makeBuilding({ building_id: 'maple', building_name: 'Maple Building' })]);
    useOrganizationsMock.mockReturnValue(
      liveResult([makeOrganization({ organization_id: 'scouts', name: 'Scouts' })]),
    );
    const seat = makeSeat({
      type: 'manual',
      scope: 'stake',
      callings: [],
      reason: 'sub teacher',
      building_names: ['Maple Building'],
      organization_id: 'scouts',
    });
    render(<EditSeatDialog seat={seat} onOpenChange={() => {}} />);
    await user.selectOptions(screen.getByTestId('edit-seat-organization'), '__none__');
    await user.type(screen.getByTestId('edit-seat-comment'), 'note');
    await user.click(screen.getByTestId('edit-seat-confirm'));
    await waitFor(() => expect(submitMutateAsync).toHaveBeenCalledTimes(1));
    const arg = submitMutateAsync.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(arg.organization_id).toBeNull();
  });
});

describe('<EditSeatDialog /> — limited app access (D25)', () => {
  // `canEditSeat` guarantees only temp seats reach this dialog for a
  // limited principal, so every case below is `edit_temp`.

  function tempSeat(scope: string) {
    return makeSeat({
      type: 'temp',
      scope,
      callings: [],
      reason: 'visiting speaker',
      building_names: ['Maple Building'],
      start_date: '2026-05-01',
      end_date: '2026-05-08',
    });
  }

  function wardCatalogue() {
    mockCatalogue(
      [makeWard({ ward_code: 'CO', building_name: 'Maple Building' })],
      [
        makeBuilding({ building_id: 'maple', building_name: 'Maple Building' }),
        makeBuilding({ building_id: 'cedar', building_name: 'Cedar Building' }),
      ],
    );
  }

  it('states the 90-day cap above the date fields', () => {
    usePrincipalMock.mockReturnValue(principal({ limited: true }));
    wardCatalogue();
    render(<EditSeatDialog seat={tempSeat('CO')} onOpenChange={() => {}} />);
    expect(screen.getByTestId('edit-seat-temp-cap-hint')).toHaveTextContent(/90 days/i);
  });

  it('regression — a NON-limited edit_temp dialog shows no cap hint', () => {
    wardCatalogue();
    render(<EditSeatDialog seat={tempSeat('CO')} onOpenChange={() => {}} />);
    expect(screen.queryByTestId('edit-seat-temp-cap-hint')).toBeNull();
  });

  it('blocks an edit stretching the window past 90 days', async () => {
    const user = userEvent.setup();
    usePrincipalMock.mockReturnValue(principal({ limited: true }));
    wardCatalogue();
    render(<EditSeatDialog seat={tempSeat('CO')} onOpenChange={() => {}} />);
    await user.clear(screen.getByTestId('edit-seat-end-date'));
    await user.type(screen.getByTestId('edit-seat-end-date'), '2026-07-31');
    await user.type(screen.getByTestId('edit-seat-comment'), 'extending');
    await user.click(screen.getByTestId('edit-seat-confirm'));
    // The cap hint carries the same copy, so match on the alert role.
    const alerts = await screen.findAllByRole('alert');
    expect(alerts.some((el) => /limited to 90 days/i.test(el.textContent ?? ''))).toBe(true);
    expect(submitMutateAsync).not.toHaveBeenCalled();
  });

  it('admits an edit landing exactly on the 90-day boundary', async () => {
    const user = userEvent.setup();
    usePrincipalMock.mockReturnValue(principal({ limited: true }));
    wardCatalogue();
    render(<EditSeatDialog seat={tempSeat('CO')} onOpenChange={() => {}} />);
    await user.clear(screen.getByTestId('edit-seat-end-date'));
    await user.type(screen.getByTestId('edit-seat-end-date'), '2026-07-30');
    await user.type(screen.getByTestId('edit-seat-comment'), 'extending');
    await user.click(screen.getByTestId('edit-seat-confirm'));
    await waitFor(() => expect(submitMutateAsync).toHaveBeenCalledTimes(1));
    expect(submitMutateAsync.mock.calls[0]?.[0]).toMatchObject({
      type: 'edit_temp',
      end_date: '2026-07-30',
    });
  });

  it('ward scope: locks the buildings to the ward building and renders no checkboxes', () => {
    usePrincipalMock.mockReturnValue(principal({ limited: true }));
    wardCatalogue();
    render(<EditSeatDialog seat={tempSeat('CO')} onOpenChange={() => {}} />);
    expect(screen.getByTestId('edit-seat-locked-building')).toHaveTextContent('Maple Building');
    expect(screen.queryByTestId('edit-seat-building-maple')).toBeNull();
    expect(screen.queryByTestId('edit-seat-building-cedar')).toBeNull();
  });

  it('ward scope: submits exactly the ward building even when the seat carried more', async () => {
    const user = userEvent.setup();
    usePrincipalMock.mockReturnValue(principal({ limited: true }));
    wardCatalogue();
    const seat = makeSeat({
      type: 'temp',
      scope: 'CO',
      callings: [],
      reason: 'visiting speaker',
      building_names: ['Maple Building', 'Cedar Building'],
      start_date: '2026-05-01',
      end_date: '2026-05-08',
    });
    render(<EditSeatDialog seat={seat} onOpenChange={() => {}} />);
    await user.type(screen.getByTestId('edit-seat-comment'), 'shortening the grant');
    await user.click(screen.getByTestId('edit-seat-confirm'));
    await waitFor(() => expect(submitMutateAsync).toHaveBeenCalledTimes(1));
    expect(submitMutateAsync.mock.calls[0]?.[0]).toMatchObject({
      type: 'edit_temp',
      scope: 'CO',
      building_names: ['Maple Building'],
    });
  });

  it('ward scope with no building configured: blocks with a message and a disabled Submit', () => {
    usePrincipalMock.mockReturnValue(principal({ limited: true }));
    mockCatalogue(
      [makeWard({ ward_code: 'CO', building_name: '' })],
      [makeBuilding({ building_id: 'maple', building_name: 'Maple Building' })],
    );
    render(<EditSeatDialog seat={tempSeat('CO')} onOpenChange={() => {}} />);
    expect(screen.getByTestId('edit-seat-locked-building-missing')).toHaveTextContent(
      /Kindoo Manager/i,
    );
    expect(screen.getByTestId('edit-seat-confirm')).toBeDisabled();
  });

  it('stake scope: keeps the ordinary checklist', () => {
    usePrincipalMock.mockReturnValue(principal({ limited: true }));
    mockCatalogue(
      [],
      [
        makeBuilding({ building_id: 'maple', building_name: 'Maple Building' }),
        makeBuilding({ building_id: 'cedar', building_name: 'Cedar Building' }),
      ],
    );
    render(<EditSeatDialog seat={tempSeat('stake')} onOpenChange={() => {}} />);
    expect(screen.getByTestId('edit-seat-building-maple')).toBeInTheDocument();
    expect(screen.getByTestId('edit-seat-building-cedar')).toBeInTheDocument();
    expect(screen.queryByTestId('edit-seat-locked-building')).toBeNull();
  });

  it('regression — a NON-limited ward edit keeps the checklist and the seat’s own selection', () => {
    wardCatalogue();
    const seat = makeSeat({
      type: 'temp',
      scope: 'CO',
      callings: [],
      reason: 'visiting speaker',
      building_names: ['Maple Building', 'Cedar Building'],
      start_date: '2026-05-01',
      end_date: '2026-05-08',
    });
    render(<EditSeatDialog seat={seat} onOpenChange={() => {}} />);
    expect(screen.queryByTestId('edit-seat-locked-building')).toBeNull();
    expect((screen.getByTestId('edit-seat-building-maple') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId('edit-seat-building-cedar') as HTMLInputElement).checked).toBe(true);
  });
});

describe('<EditSeatDialog /> — limited temp window reports live (D25)', () => {
  // Mirrors NewRequestForm: the ≤90-day cap lands as soon as both dates
  // hold a date, not on Submit, and only for a limited principal on
  // `edit_temp`. Everything else keeps submit-time validation.

  function tempSeat(overrides: { start_date?: string; end_date?: string } = {}) {
    return makeSeat({
      type: 'temp',
      scope: 'CO',
      callings: [],
      reason: 'visiting speaker',
      building_names: ['Maple Building'],
      start_date: overrides.start_date ?? '2026-05-01',
      end_date: overrides.end_date ?? '2026-05-08',
    });
  }

  function wardCatalogue() {
    mockCatalogue(
      [makeWard({ ward_code: 'CO', building_name: 'Maple Building' })],
      [makeBuilding({ building_id: 'maple', building_name: 'Maple Building' })],
    );
  }

  /** The inline cap error, not the always-present helper text — the two
   *  carry identical copy and only the error has `role="alert"`. */
  function capError(): HTMLElement | undefined {
    return screen
      .queryAllByRole('alert')
      .find((el) => /limited to 90 days/i.test(el.textContent ?? ''));
  }

  it('shows the cap message as soon as the end date stretches past 90 days, with no submit', async () => {
    const user = userEvent.setup();
    usePrincipalMock.mockReturnValue(principal({ limited: true }));
    wardCatalogue();
    render(<EditSeatDialog seat={tempSeat()} onOpenChange={() => {}} />);
    expect(capError()).toBeUndefined();
    await user.clear(screen.getByTestId('edit-seat-end-date'));
    await user.type(screen.getByTestId('edit-seat-end-date'), '2026-07-31'); // 91 days
    await waitFor(() => expect(capError()).toBeDefined());
    expect(submitMutateAsync).not.toHaveBeenCalled();
  });

  it('renders the live cap message under the End date field', async () => {
    const user = userEvent.setup();
    usePrincipalMock.mockReturnValue(principal({ limited: true }));
    wardCatalogue();
    render(<EditSeatDialog seat={tempSeat()} onOpenChange={() => {}} />);
    await user.clear(screen.getByTestId('edit-seat-end-date'));
    await user.type(screen.getByTestId('edit-seat-end-date'), '2026-07-31');
    await waitFor(() => expect(capError()).toBeDefined());
    const endDate = screen.getByTestId('edit-seat-end-date');
    expect(endDate.compareDocumentPosition(capError() as HTMLElement)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it('clears the cap message when the end date comes back to 90 days, with no submit', async () => {
    const user = userEvent.setup();
    usePrincipalMock.mockReturnValue(principal({ limited: true }));
    wardCatalogue();
    render(<EditSeatDialog seat={tempSeat()} onOpenChange={() => {}} />);
    await user.clear(screen.getByTestId('edit-seat-end-date'));
    await user.type(screen.getByTestId('edit-seat-end-date'), '2026-07-31'); // 91 days
    await waitFor(() => expect(capError()).toBeDefined());
    await user.clear(screen.getByTestId('edit-seat-end-date'));
    await user.type(screen.getByTestId('edit-seat-end-date'), '2026-07-30'); // 90 days
    await waitFor(() => expect(capError()).toBeUndefined());
    expect(submitMutateAsync).not.toHaveBeenCalled();
  });

  it('reports a seat that already exceeds the cap the moment the dialog opens', async () => {
    // Both dates arrive pre-filled from the seat, so the pair is
    // complete at mount — a limited user must see straight away that
    // this window is not one they can re-submit.
    usePrincipalMock.mockReturnValue(principal({ limited: true }));
    wardCatalogue();
    render(<EditSeatDialog seat={tempSeat({ end_date: '2026-07-31' })} onOpenChange={() => {}} />);
    await waitFor(() => expect(capError()).toBeDefined());
  });

  it('raises nothing while the end date sits empty', async () => {
    const user = userEvent.setup();
    usePrincipalMock.mockReturnValue(principal({ limited: true }));
    wardCatalogue();
    render(<EditSeatDialog seat={tempSeat()} onOpenChange={() => {}} />);
    await user.clear(screen.getByTestId('edit-seat-end-date'));
    // Half a pair must not surface "End date is required" before the
    // user has typed the replacement.
    expect(screen.queryAllByRole('alert')).toHaveLength(0);
  });

  it('regression — a NON-limited 200-day edit stays silent and no field errors while typing', async () => {
    const user = userEvent.setup();
    wardCatalogue();
    render(
      <EditSeatDialog
        seat={tempSeat({ start_date: '2026-01-01', end_date: '2026-01-08' })}
        onOpenChange={() => {}}
      />,
    );
    await user.clear(screen.getByTestId('edit-seat-end-date'));
    await user.type(screen.getByTestId('edit-seat-end-date'), '2026-07-20'); // 200 days
    expect(screen.queryAllByRole('alert')).toHaveLength(0);
    // The dialog's global validation mode is unchanged — the required
    // reason and comment stay quiet until Submit.
    await user.clear(screen.getByTestId('edit-seat-reason'));
    await user.type(screen.getByTestId('edit-seat-comment'), 'x');
    await user.clear(screen.getByTestId('edit-seat-comment'));
    expect(screen.queryAllByRole('alert')).toHaveLength(0);
  });

  it('regression — a limited dialog leaves the non-date fields on submit-time validation', async () => {
    const user = userEvent.setup();
    usePrincipalMock.mockReturnValue(principal({ limited: true }));
    wardCatalogue();
    render(<EditSeatDialog seat={tempSeat()} onOpenChange={() => {}} />);
    await user.clear(screen.getByTestId('edit-seat-end-date'));
    await user.type(screen.getByTestId('edit-seat-end-date'), '2026-07-30'); // 90 days, valid
    await user.clear(screen.getByTestId('edit-seat-reason'));
    // The live check revalidates `end_date` and nothing else, so the
    // emptied reason and the still-empty required comment stay silent.
    expect(screen.queryAllByRole('alert')).toHaveLength(0);
  });
});
