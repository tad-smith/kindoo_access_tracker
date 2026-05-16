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
  it('renders the ward template building pre-checked AND disabled with a Church-managed note', () => {
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
