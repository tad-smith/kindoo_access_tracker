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
import type { Building, Ward } from '@kindoo/shared';
import { makeSeat, makeWard } from '../../../../test/fixtures';

const submitMutateAsync = vi.fn().mockResolvedValue({ id: 'req-new' });
const useStakeWardsMock = vi.fn();
const useStakeBuildingsMock = vi.fn();

vi.mock('../hooks', () => ({
  useSubmitRequest: () => ({ mutateAsync: submitMutateAsync, isPending: false }),
  useStakeWards: () => useStakeWardsMock(),
  useStakeBuildings: () => useStakeBuildingsMock(),
}));

import { EditSeatDialog } from './EditSeatDialog';

const FAKE_TS = { seconds: 0, nanoseconds: 0, toDate: () => new Date(), toMillis: () => 0 };
const FAKE_ACTOR = { email: 'a@b.c', canonical: 'a@b.c' } as const;

function makeBuilding(overrides: Partial<Building> = {}): Building {
  return {
    building_id: 'cordera',
    building_name: 'Cordera Building',
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

beforeEach(() => {
  vi.clearAllMocks();
  submitMutateAsync.mockResolvedValue({ id: 'req-new' });
});

describe('<EditSeatDialog /> — edit_auto sub-type', () => {
  it('renders every auto-granted building pre-checked AND disabled; non-granted buildings are unchecked + enabled', () => {
    mockCatalogue(
      [makeWard({ ward_code: 'CO', building_name: 'Cordera Building' })],
      [
        makeBuilding({ building_id: 'cordera', building_name: 'Cordera Building' }),
        makeBuilding({ building_id: 'genoa', building_name: 'Genoa Building' }),
      ],
    );
    const seat = makeSeat({
      type: 'auto',
      scope: 'CO',
      callings: ['Bishop'],
      building_names: ['Cordera Building'],
    });
    render(<EditSeatDialog seat={seat} onOpenChange={() => {}} />);
    const corderaCb = screen.getByTestId('edit-seat-building-cordera') as HTMLInputElement;
    const genoaCb = screen.getByTestId('edit-seat-building-genoa') as HTMLInputElement;
    expect(corderaCb.checked).toBe(true);
    expect(corderaCb.disabled).toBe(true);
    expect(genoaCb.checked).toBe(false);
    expect(genoaCb.disabled).toBe(false);
    expect(screen.getByTestId('edit-seat-building-locked-cordera')).toBeInTheDocument();
  });

  it('locks every building in seat.building_names (not just ward.building_name) — prior edit_auto adds stay locked too', () => {
    // Regression: a previous interpretation locked only the ward's
    // template building, which left "operator-added extras from a prior
    // edit_auto" as uncheckable. The locked set is now seat.building_names
    // in full so the user can never silently remove an existing grant
    // through this dialog.
    mockCatalogue(
      [makeWard({ ward_code: 'CO', building_name: 'Cordera Building' })],
      [
        makeBuilding({ building_id: 'cordera', building_name: 'Cordera Building' }),
        makeBuilding({ building_id: 'genoa', building_name: 'Genoa Building' }),
        makeBuilding({ building_id: 'prairie', building_name: 'Prairie Building' }),
      ],
    );
    const seat = makeSeat({
      type: 'auto',
      scope: 'CO',
      callings: ['Bishop'],
      building_names: ['Cordera Building', 'Genoa Building'],
    });
    render(<EditSeatDialog seat={seat} onOpenChange={() => {}} />);
    const corderaCb = screen.getByTestId('edit-seat-building-cordera') as HTMLInputElement;
    const genoaCb = screen.getByTestId('edit-seat-building-genoa') as HTMLInputElement;
    const prairieCb = screen.getByTestId('edit-seat-building-prairie') as HTMLInputElement;
    expect(corderaCb.checked).toBe(true);
    expect(corderaCb.disabled).toBe(true);
    expect(genoaCb.checked).toBe(true);
    expect(genoaCb.disabled).toBe(true);
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
      [makeWard({ ward_code: 'CO', building_name: 'Cordera Building' })],
      [
        makeBuilding({ building_id: 'cordera', building_name: 'Cordera Building' }),
        makeBuilding({ building_id: 'genoa', building_name: 'Genoa Building' }),
        makeBuilding({ building_id: 'prairie', building_name: 'Prairie Building' }),
      ],
    );
    const seat = makeSeat({
      type: 'auto',
      scope: 'CO',
      callings: ['Bishop'],
      building_names: ['Cordera Building'],
      duplicate_grants: [
        {
          scope: 'CO',
          type: 'manual',
          building_names: ['Genoa Building'],
          detected_at: FAKE_TS,
        },
      ],
    });
    render(<EditSeatDialog seat={seat} onOpenChange={() => {}} />);
    const corderaCb = screen.getByTestId('edit-seat-building-cordera') as HTMLInputElement;
    const genoaCb = screen.getByTestId('edit-seat-building-genoa') as HTMLInputElement;
    const prairieCb = screen.getByTestId('edit-seat-building-prairie') as HTMLInputElement;
    expect(corderaCb.checked).toBe(true);
    expect(corderaCb.disabled).toBe(true);
    expect(genoaCb.checked).toBe(true);
    expect(genoaCb.disabled).toBe(true);
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
      [makeWard({ ward_code: 'CO', building_name: 'Cordera Building' })],
      [
        makeBuilding({ building_id: 'cordera', building_name: 'Cordera Building' }),
        makeBuilding({ building_id: 'genoa', building_name: 'Genoa Building' }),
      ],
    );
    const seat = makeSeat({
      type: 'auto',
      scope: 'CO',
      callings: ['Bishop'],
      building_names: ['Cordera Building'],
      duplicate_grants: [
        {
          scope: 'CO',
          type: 'temp',
          building_names: ['Genoa Building'],
          start_date: '2026-06-01',
          end_date: '2026-06-15',
          detected_at: FAKE_TS,
        },
      ],
    });
    render(<EditSeatDialog seat={seat} onOpenChange={() => {}} />);
    const corderaCb = screen.getByTestId('edit-seat-building-cordera') as HTMLInputElement;
    const genoaCb = screen.getByTestId('edit-seat-building-genoa') as HTMLInputElement;
    expect(corderaCb.checked).toBe(true);
    expect(corderaCb.disabled).toBe(true);
    expect(genoaCb.checked).toBe(true);
    expect(genoaCb.disabled).toBe(true);
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
    //     must be ['Cordera Building'], NOT
    //     ['Cordera Building', 'Genoa Building'].
    const user = userEvent.setup();
    mockCatalogue(
      [makeWard({ ward_code: 'CO', building_name: 'Cordera Building' })],
      [
        makeBuilding({ building_id: 'cordera', building_name: 'Cordera Building' }),
        makeBuilding({ building_id: 'genoa', building_name: 'Genoa Building' }),
      ],
    );
    const seat = makeSeat({
      type: 'auto',
      scope: 'CO',
      callings: ['Bishop'],
      building_names: ['Cordera Building'],
      duplicate_grants: [
        {
          scope: 'CO',
          type: 'manual',
          building_names: ['Genoa Building'],
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
    expect(arg.building_names).toEqual(['Cordera Building']);
    // Explicit defense — the dup-only building must NOT appear in the
    // submit body.
    expect(arg.building_names).not.toContain('Genoa Building');
  });

  it('with a non-auto dup present, adding a new building submits [auto-primary..., new-building] — dup buildings still excluded', async () => {
    // Same separation as above, exercising the add path. The operator
    // ticks Prairie Building (not part of either the auto-primary set
    // or the dup). The submit body must include the auto-primary + the
    // new add, and MUST NOT include the dup building even though it
    // renders visually checked.
    const user = userEvent.setup();
    mockCatalogue(
      [makeWard({ ward_code: 'CO', building_name: 'Cordera Building' })],
      [
        makeBuilding({ building_id: 'cordera', building_name: 'Cordera Building' }),
        makeBuilding({ building_id: 'genoa', building_name: 'Genoa Building' }),
        makeBuilding({ building_id: 'prairie', building_name: 'Prairie Building' }),
      ],
    );
    const seat = makeSeat({
      type: 'auto',
      scope: 'CO',
      callings: ['Bishop'],
      building_names: ['Cordera Building'],
      duplicate_grants: [
        {
          scope: 'CO',
          type: 'manual',
          building_names: ['Genoa Building'],
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
    expect([...arg.building_names].sort()).toEqual(['Cordera Building', 'Prairie Building']);
    expect(arg.building_names).not.toContain('Genoa Building');
  });

  it('surfaces a tooltip on each disabled (locked) checkbox explaining why it cannot be unchecked', () => {
    mockCatalogue(
      [makeWard({ ward_code: 'CO', building_name: 'Cordera Building' })],
      [makeBuilding({ building_id: 'cordera', building_name: 'Cordera Building' })],
    );
    const seat = makeSeat({
      type: 'auto',
      scope: 'CO',
      callings: ['Bishop'],
      building_names: ['Cordera Building'],
    });
    render(<EditSeatDialog seat={seat} onOpenChange={() => {}} />);
    const corderaCb = screen.getByTestId('edit-seat-building-cordera') as HTMLInputElement;
    // The title attribute is what the browser surfaces as a tooltip on
    // hover; for the disabled checkbox the same title goes on the
    // wrapping label too so the hover surface includes the text label.
    expect(corderaCb.getAttribute('title')).toMatch(/already granted/i);
  });

  it('omits the Calling / Reason field on edit_auto', () => {
    mockCatalogue(
      [makeWard({ ward_code: 'CO', building_name: 'Cordera Building' })],
      [makeBuilding()],
    );
    const seat = makeSeat({
      type: 'auto',
      scope: 'CO',
      callings: ['Bishop'],
      building_names: ['Cordera Building'],
    });
    render(<EditSeatDialog seat={seat} onOpenChange={() => {}} />);
    expect(screen.queryByTestId('edit-seat-reason')).toBeNull();
  });

  it('submits an edit_auto request whose building_names union includes the locked template building plus operator additions', async () => {
    const user = userEvent.setup();
    mockCatalogue(
      [makeWard({ ward_code: 'CO', building_name: 'Cordera Building' })],
      [
        makeBuilding({ building_id: 'cordera', building_name: 'Cordera Building' }),
        makeBuilding({ building_id: 'genoa', building_name: 'Genoa Building' }),
      ],
    );
    const seat = makeSeat({
      type: 'auto',
      scope: 'CO',
      member_email: 'auto@x.com',
      member_canonical: 'auto@x.com',
      member_name: 'Auto Person',
      callings: ['Bishop'],
      building_names: ['Cordera Building'],
    });
    render(<EditSeatDialog seat={seat} onOpenChange={() => {}} />);
    await user.click(screen.getByTestId('edit-seat-building-genoa'));
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
    expect([...arg.building_names].sort()).toEqual(['Cordera Building', 'Genoa Building']);
    expect(arg.comment).toBe('note');
    // No dates on edit_auto.
    expect(arg.start_date).toBeUndefined();
    expect(arg.end_date).toBeUndefined();
  });

  it('renders a required Comment field in the dialog body', () => {
    mockCatalogue(
      [makeWard({ ward_code: 'CO', building_name: 'Cordera Building' })],
      [makeBuilding({ building_id: 'cordera', building_name: 'Cordera Building' })],
    );
    const seat = makeSeat({
      type: 'auto',
      scope: 'CO',
      callings: ['Bishop'],
      building_names: ['Cordera Building'],
    });
    render(<EditSeatDialog seat={seat} onOpenChange={() => {}} />);
    expect(screen.getByTestId('edit-seat-comment')).toBeInTheDocument();
    expect(screen.getByTestId('edit-seat-comment-marker').textContent).toMatch(/required/i);
  });

  it('blocks submit with an inline error when comment is empty', async () => {
    const user = userEvent.setup();
    mockCatalogue(
      [makeWard({ ward_code: 'CO', building_name: 'Cordera Building' })],
      [makeBuilding({ building_id: 'cordera', building_name: 'Cordera Building' })],
    );
    const seat = makeSeat({
      type: 'auto',
      scope: 'CO',
      callings: ['Bishop'],
      building_names: ['Cordera Building'],
    });
    render(<EditSeatDialog seat={seat} onOpenChange={() => {}} />);
    await user.click(screen.getByTestId('edit-seat-confirm'));
    expect(submitMutateAsync).not.toHaveBeenCalled();
    expect(screen.getByTestId('edit-seat-comment-error')).toBeInTheDocument();
  });

  it('blocks submit with an inline error when comment is whitespace-only', async () => {
    const user = userEvent.setup();
    mockCatalogue(
      [makeWard({ ward_code: 'CO', building_name: 'Cordera Building' })],
      [makeBuilding({ building_id: 'cordera', building_name: 'Cordera Building' })],
    );
    const seat = makeSeat({
      type: 'auto',
      scope: 'CO',
      callings: ['Bishop'],
      building_names: ['Cordera Building'],
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
        makeBuilding({ building_id: 'cordera', building_name: 'Cordera Building' }),
        makeBuilding({ building_id: 'genoa', building_name: 'Genoa Building' }),
      ],
    );
    const seat = makeSeat({
      type: 'manual',
      scope: 'CO',
      callings: [],
      reason: 'sub teacher',
      building_names: ['Cordera Building'],
    });
    render(<EditSeatDialog seat={seat} onOpenChange={() => {}} />);
    const corderaCb = screen.getByTestId('edit-seat-building-cordera') as HTMLInputElement;
    const genoaCb = screen.getByTestId('edit-seat-building-genoa') as HTMLInputElement;
    expect(corderaCb.checked).toBe(true);
    expect(corderaCb.disabled).toBe(false);
    expect(genoaCb.checked).toBe(false);
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
        makeBuilding({ building_id: 'cordera', building_name: 'Cordera Building' }),
        makeBuilding({ building_id: 'genoa', building_name: 'Genoa Building' }),
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
      building_names: ['Cordera Building'],
    });
    render(<EditSeatDialog seat={seat} onOpenChange={() => {}} />);
    // Add the second building.
    await user.click(screen.getByTestId('edit-seat-building-genoa'));
    await user.type(screen.getByTestId('edit-seat-comment'), 'note');
    await user.click(screen.getByTestId('edit-seat-confirm'));
    await waitFor(() => expect(submitMutateAsync).toHaveBeenCalledTimes(1));
    const arg = submitMutateAsync.mock.calls[0]?.[0] as Record<string, unknown> & {
      building_names: string[];
    };
    expect(arg.type).toBe('edit_manual');
    expect(arg.reason).toBe('sub teacher');
    expect([...arg.building_names].sort()).toEqual(['Cordera Building', 'Genoa Building']);
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
      [makeBuilding({ building_id: 'cordera', building_name: 'Cordera Building' })],
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
      [makeBuilding({ building_id: 'cordera', building_name: 'Cordera Building' })],
    );
    const seat = makeSeat({
      type: 'manual',
      scope: 'CO',
      callings: [],
      reason: 'sub teacher',
      building_names: ['Cordera Building'],
    });
    render(<EditSeatDialog seat={seat} onOpenChange={() => {}} />);
    expect(screen.getByTestId('edit-seat-comment')).toBeInTheDocument();
    expect(screen.getByTestId('edit-seat-comment-marker').textContent).toMatch(/required/i);
  });

  it('blocks submit with an inline error when comment is empty', async () => {
    const user = userEvent.setup();
    mockCatalogue(
      [makeWard({ ward_code: 'CO' })],
      [makeBuilding({ building_id: 'cordera', building_name: 'Cordera Building' })],
    );
    const seat = makeSeat({
      type: 'manual',
      scope: 'CO',
      callings: [],
      reason: 'sub teacher',
      building_names: ['Cordera Building'],
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
      [makeBuilding({ building_id: 'cordera', building_name: 'Cordera Building' })],
    );
    const seat = makeSeat({
      type: 'manual',
      scope: 'CO',
      callings: [],
      reason: 'sub teacher',
      building_names: ['Cordera Building'],
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
      [makeBuilding({ building_id: 'cordera', building_name: 'Cordera Building' })],
    );
    const seat = makeSeat({
      type: 'temp',
      scope: 'CO',
      callings: [],
      reason: 'youth conference',
      building_names: ['Cordera Building'],
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
      [makeBuilding({ building_id: 'cordera', building_name: 'Cordera Building' })],
    );
    const seat = makeSeat({
      type: 'temp',
      scope: 'CO',
      member_email: 'temp@x.com',
      member_canonical: 'temp@x.com',
      member_name: 'Temp Person',
      callings: [],
      reason: 'youth conference',
      building_names: ['Cordera Building'],
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
    expect(arg.building_names).toEqual(['Cordera Building']);
    expect(arg.comment).toBe('note');
    expect(arg.start_date).toBe('2026-05-01');
    expect(arg.end_date).toBe('2026-05-15');
  });

  it('blocks submission when end_date precedes start_date', async () => {
    const user = userEvent.setup();
    mockCatalogue(
      [makeWard({ ward_code: 'CO' })],
      [makeBuilding({ building_id: 'cordera', building_name: 'Cordera Building' })],
    );
    const seat = makeSeat({
      type: 'temp',
      scope: 'CO',
      callings: [],
      reason: 'youth conference',
      building_names: ['Cordera Building'],
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
      [makeBuilding({ building_id: 'cordera', building_name: 'Cordera Building' })],
    );
    const seat = makeSeat({
      type: 'temp',
      scope: 'CO',
      callings: [],
      reason: '',
      building_names: ['Cordera Building'],
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
      [makeBuilding({ building_id: 'cordera', building_name: 'Cordera Building' })],
    );
    const seat = makeSeat({
      type: 'temp',
      scope: 'CO',
      callings: [],
      reason: 'youth conference',
      building_names: ['Cordera Building'],
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
      [makeBuilding({ building_id: 'cordera', building_name: 'Cordera Building' })],
    );
    const seat = makeSeat({
      type: 'temp',
      scope: 'CO',
      callings: [],
      reason: 'youth conference',
      building_names: ['Cordera Building'],
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
      [makeBuilding({ building_id: 'cordera', building_name: 'Cordera Building' })],
    );
    const seat = makeSeat({
      type: 'temp',
      scope: 'CO',
      callings: [],
      reason: 'youth conference',
      building_names: ['Cordera Building'],
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
      [
        makeWard({
          ward_code: 'FN',
          building_name: 'Foothills Building',
          kindoo_site_id: 'foreign-1',
        }),
      ],
      [
        makeBuilding({
          building_id: 'cordera',
          building_name: 'Cordera Building',
          kindoo_site_id: null,
        }),
        makeBuilding({
          building_id: 'foothills',
          building_name: 'Foothills Building',
          kindoo_site_id: 'foreign-1',
        }),
      ],
    );
    const seat = makeSeat({
      type: 'manual',
      scope: 'FN',
      callings: [],
      reason: 'sub teacher',
      building_names: ['Foothills Building'],
    });
    render(<EditSeatDialog seat={seat} onOpenChange={() => {}} />);
    expect(screen.getByTestId('edit-seat-building-foothills')).toBeInTheDocument();
    expect(screen.queryByTestId('edit-seat-building-cordera')).toBeNull();
  });

  it('shows ONLY home-site buildings on a home ward seat', () => {
    mockCatalogue(
      [makeWard({ ward_code: 'CO', building_name: 'Cordera Building' })],
      [
        makeBuilding({
          building_id: 'cordera',
          building_name: 'Cordera Building',
          kindoo_site_id: null,
        }),
        makeBuilding({
          building_id: 'foothills',
          building_name: 'Foothills Building',
          kindoo_site_id: 'foreign-1',
        }),
      ],
    );
    const seat = makeSeat({
      type: 'manual',
      scope: 'CO',
      callings: [],
      reason: 'sub teacher',
      building_names: ['Cordera Building'],
    });
    render(<EditSeatDialog seat={seat} onOpenChange={() => {}} />);
    expect(screen.getByTestId('edit-seat-building-cordera')).toBeInTheDocument();
    expect(screen.queryByTestId('edit-seat-building-foothills')).toBeNull();
  });

  it('drops a seat building_name outside the visible set from the form defaults (Risk 2 clamp)', () => {
    // Ward FN is foreign-1; seat's `building_names` carries a stale
    // home building ('Cordera Building'). The home building is hidden
    // by the site filter; the form must NOT pre-check it (which would
    // be invisible and impossible to uncheck) and must NOT ship it on
    // submit. With no foreign building also ticked, the dialog renders
    // zero pre-checked checkboxes.
    mockCatalogue(
      [
        makeWard({
          ward_code: 'FN',
          building_name: 'Foothills Building',
          kindoo_site_id: 'foreign-1',
        }),
      ],
      [
        makeBuilding({
          building_id: 'cordera',
          building_name: 'Cordera Building',
          kindoo_site_id: null,
        }),
        makeBuilding({
          building_id: 'foothills',
          building_name: 'Foothills Building',
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
      building_names: ['Cordera Building'],
    });
    render(<EditSeatDialog seat={seat} onOpenChange={() => {}} />);
    // Hidden home building's checkbox is not rendered at all.
    expect(screen.queryByTestId('edit-seat-building-cordera')).toBeNull();
    // Visible foreign building is rendered but NOT pre-checked.
    expect(screen.getByTestId('edit-seat-building-foothills')).not.toBeChecked();
  });

  it('renders an empty-state when the site filter narrows the catalogue to zero', () => {
    // Foreign-site ward but no foreign building configured yet → the
    // visible set is empty. The dialog renders an explicit message
    // rather than an empty list.
    mockCatalogue(
      [
        makeWard({
          ward_code: 'FN',
          building_name: '',
          kindoo_site_id: 'foreign-1',
        }),
      ],
      [
        makeBuilding({
          building_id: 'cordera',
          building_name: 'Cordera Building',
          kindoo_site_id: null,
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
    expect(screen.queryByTestId('edit-seat-building-cordera')).toBeNull();
  });
});

describe('<EditSeatDialog /> — dialog lifecycle', () => {
  it('closes via onOpenChange(false) after a successful submit', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    mockCatalogue(
      [makeWard({ ward_code: 'CO' })],
      [makeBuilding({ building_id: 'cordera', building_name: 'Cordera Building' })],
    );
    const seat = makeSeat({
      type: 'manual',
      scope: 'CO',
      callings: [],
      reason: 'sub teacher',
      building_names: ['Cordera Building'],
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
