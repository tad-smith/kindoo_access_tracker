// Component tests for the shared NewRequestForm. Mocks the submit
// mutation + duplicate-warning subscription so the test exercises just
// the validation + render shape.
//
// Coverage target:
//   - Member name + reason are required (`add_manual` / `add_temp`).
//   - `add_temp` shows date inputs with both required.
//   - `add_temp` end < start fails validation.
//   - Stake-scope add types require ≥1 building checkbox.
//   - The buildings selector is collapsible with scope-driven defaults:
//     - scope == 'stake' → panel expanded, EVERY building pre-checked
//       (B-11 — stake-scope means "everywhere"; manager unchecks to
//       exclude).
//     - scope == <ward>  → panel collapsed, that ward's building
//       pre-checked and shown in the header summary.
//     - selection state survives expand/collapse toggles within the
//       same scope; the next scope flip resets both the selection and
//       the open state to the new scope's derivation.
//   - Ward users can expand and check additional buildings (multi-
//     select).
//   - Duplicate error surfaces (and Submit is disabled) when the live
//     seat hook returns a hit in the same scope.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Building, Organization, Seat, Ward } from '@kindoo/shared';

const submitMock = vi.fn().mockResolvedValue({ id: 'req-stub' });
const useSeatForMemberMock = vi.fn();
const toastMock = vi.fn();

vi.mock('../hooks', () => ({
  useSubmitRequest: () => ({ mutateAsync: submitMock, isPending: false }),
  useSeatForMember: (canonical: string | null) => useSeatForMemberMock(canonical),
}));

vi.mock('../../../lib/store/toast', () => ({
  toast: (...args: unknown[]) => toastMock(...args),
}));

// The org selector subscribes to the organizations catalogue. Override
// `useOrganizations` per-test via `useOrganizationsMock`; default to an
// empty live result. Keep the real pure helpers.
const useOrganizationsMock = vi.fn();
vi.mock('../../organizations/hooks', async () => {
  const actual = await vi.importActual<object>('../../organizations/hooks');
  return {
    ...actual,
    useOrganizations: () => useOrganizationsMock(),
  };
});

import { NewRequestForm } from '../components/NewRequestForm';
import { Dialog } from '../../../components/ui/Dialog';

function liveSeatResult(seat: Seat | undefined) {
  return {
    data: seat,
    error: null,
    status: 'success',
    isPending: false,
    isLoading: false,
    isSuccess: true,
    isError: false,
    isFetching: false,
    fetchStatus: 'idle',
  } as const;
}

function wards(
  opts: { code: string; building_name: string; kindoo_site_id?: string | null }[] = [],
): Ward[] {
  const stamp = { seconds: 0, nanoseconds: 0, toDate: () => new Date(), toMillis: () => 0 };
  return opts.map(
    ({ code, building_name, kindoo_site_id }) =>
      ({
        ward_code: code,
        ward_name: `Ward ${code}`,
        building_name,
        seat_cap: 20,
        ...(kindoo_site_id !== undefined ? { kindoo_site_id } : {}),
        created_at: stamp,
        last_modified_at: stamp,
        lastActor: { email: 'a@b.c', canonical: 'a@b.c' },
      }) as unknown as Ward,
  );
}

function buildings(): Building[] {
  return [
    {
      building_id: 'maple',
      building_name: 'Maple Building',
      address: '123',
      created_at: { seconds: 0, nanoseconds: 0, toDate: () => new Date(), toMillis: () => 0 },
      last_modified_at: {
        seconds: 0,
        nanoseconds: 0,
        toDate: () => new Date(),
        toMillis: () => 0,
      },
      lastActor: { email: 'a@b.c', canonical: 'a@b.c' },
    },
    {
      building_id: 'cedar',
      building_name: 'Cedar Building',
      address: '456',
      created_at: { seconds: 0, nanoseconds: 0, toDate: () => new Date(), toMillis: () => 0 },
      last_modified_at: {
        seconds: 0,
        nanoseconds: 0,
        toDate: () => new Date(),
        toMillis: () => 0,
      },
      lastActor: { email: 'a@b.c', canonical: 'a@b.c' },
    },
  ];
}

function buildingsWithSites(
  opts: Array<{ id: string; name: string; kindoo_site_id?: string | null }>,
): Building[] {
  const stamp = { seconds: 0, nanoseconds: 0, toDate: () => new Date(), toMillis: () => 0 };
  return opts.map(
    ({ id, name, kindoo_site_id }) =>
      ({
        building_id: id,
        building_name: name,
        address: '123',
        ...(kindoo_site_id !== undefined ? { kindoo_site_id } : {}),
        created_at: stamp,
        last_modified_at: stamp,
        lastActor: { email: 'a@b.c', canonical: 'a@b.c' },
      }) as unknown as Building,
  );
}

function liveOrgResult(orgs: Organization[]) {
  return {
    data: orgs,
    error: null,
    status: 'success',
    isPending: false,
    isLoading: false,
    isSuccess: true,
    isError: false,
    isFetching: false,
    fetchStatus: 'idle',
  } as const;
}

function organizations(
  opts: Array<{ id: string; name: string; seat_cap?: number }>,
): Organization[] {
  const stamp = { seconds: 0, nanoseconds: 0, toDate: () => new Date(), toMillis: () => 0 };
  return opts.map(
    ({ id, name, seat_cap }) =>
      ({
        organization_id: id,
        name,
        seat_cap: seat_cap ?? 0,
        created_at: stamp,
        last_modified_at: stamp,
        lastActor: { email: 'a@b.c', canonical: 'a@b.c' },
      }) as unknown as Organization,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  useSeatForMemberMock.mockReturnValue(liveSeatResult(undefined));
  useOrganizationsMock.mockReturnValue(liveOrgResult([]));
});

describe('<NewRequestForm /> — fixed scope label', () => {
  // The form is always launched from a scoped roster context with a
  // single allowed scope. It renders that scope as a fixed "Requesting
  // for: …" label — there is no scope picker.

  it('renders the single scope as a fixed label, never a dropdown', () => {
    render(
      <NewRequestForm
        scopes={[{ value: 'GE', label: 'Ward GE' }]}
        buildings={buildings()}
        wards={wards([{ code: 'GE', building_name: 'Cedar Building' }])}
        initialScope="GE"
      />,
    );
    expect(screen.queryByTestId('new-request-scope')).toBeNull();
    expect(screen.getByText('Requesting for:')).toBeInTheDocument();
    expect(screen.getByText('Ward GE')).toBeInTheDocument();
  });

  it('submits the launched scope even when initialScope is omitted', async () => {
    const user = userEvent.setup();
    render(
      <NewRequestForm
        scopes={[{ value: 'CO', label: 'Ward CO' }]}
        buildings={buildings()}
        wards={wards([{ code: 'CO', building_name: 'Maple Building' }])}
      />,
    );
    await user.type(screen.getByTestId('new-request-email'), 'bob@example.com');
    await user.type(screen.getByTestId('new-request-name'), 'Bob');
    await user.type(screen.getByTestId('new-request-reason'), 'visit');
    await user.click(screen.getByTestId('new-request-submit'));
    expect(submitMock).toHaveBeenCalledTimes(1);
    expect(submitMock.mock.calls[0]?.[0]).toMatchObject({ scope: 'CO' });
  });
});

describe('<NewRequestForm /> — validation', () => {
  it('renders an error when the principal has no scopes available', () => {
    render(<NewRequestForm scopes={[]} buildings={buildings()} wards={[]} />);
    expect(screen.getByText(/don't hold a bishopric or stake role/i)).toBeInTheDocument();
  });

  it('blocks submit on empty member name', async () => {
    const user = userEvent.setup();
    render(
      <NewRequestForm
        scopes={[{ value: 'CO', label: 'Ward CO' }]}
        buildings={buildings()}
        wards={wards([{ code: 'CO', building_name: 'Maple Building' }])}
      />,
    );
    await user.type(screen.getByTestId('new-request-email'), 'bob@example.com');
    await user.type(screen.getByTestId('new-request-reason'), 'sub teacher');
    await user.click(screen.getByTestId('new-request-submit'));
    expect(await screen.findByText(/member name is required/i)).toBeInTheDocument();
    expect(submitMock).not.toHaveBeenCalled();
  });

  it('blocks submit on empty reason', async () => {
    const user = userEvent.setup();
    render(
      <NewRequestForm
        scopes={[{ value: 'CO', label: 'Ward CO' }]}
        buildings={buildings()}
        wards={wards([{ code: 'CO', building_name: 'Maple Building' }])}
      />,
    );
    await user.type(screen.getByTestId('new-request-email'), 'bob@example.com');
    await user.type(screen.getByTestId('new-request-name'), 'Bob');
    await user.click(screen.getByTestId('new-request-submit'));
    expect(await screen.findByText(/reason is required/i)).toBeInTheDocument();
    expect(submitMock).not.toHaveBeenCalled();
  });

  it('shows date inputs when type is add_temp and requires both dates', async () => {
    const user = userEvent.setup();
    render(
      <NewRequestForm
        scopes={[{ value: 'CO', label: 'Ward CO' }]}
        buildings={buildings()}
        wards={wards([{ code: 'CO', building_name: 'Maple Building' }])}
      />,
    );
    await user.selectOptions(screen.getByTestId('new-request-type'), 'add_temp');
    expect(screen.getByTestId('new-request-start-date')).toBeInTheDocument();
    expect(screen.getByTestId('new-request-end-date')).toBeInTheDocument();
    await user.type(screen.getByTestId('new-request-email'), 'bob@example.com');
    await user.type(screen.getByTestId('new-request-name'), 'Bob');
    await user.type(screen.getByTestId('new-request-reason'), 'visit');
    await user.click(screen.getByTestId('new-request-submit'));
    expect(await screen.findByText(/start date is required/i)).toBeInTheDocument();
    expect(submitMock).not.toHaveBeenCalled();
  });

  it('rejects an end date before the start date', async () => {
    const user = userEvent.setup();
    render(
      <NewRequestForm
        scopes={[{ value: 'CO', label: 'Ward CO' }]}
        buildings={buildings()}
        wards={wards([{ code: 'CO', building_name: 'Maple Building' }])}
      />,
    );
    await user.selectOptions(screen.getByTestId('new-request-type'), 'add_temp');
    await user.type(screen.getByTestId('new-request-email'), 'bob@example.com');
    await user.type(screen.getByTestId('new-request-name'), 'Bob');
    await user.type(screen.getByTestId('new-request-reason'), 'visit');
    await user.type(screen.getByTestId('new-request-start-date'), '2026-05-10');
    await user.type(screen.getByTestId('new-request-end-date'), '2026-05-01');
    await user.click(screen.getByTestId('new-request-submit'));
    expect(
      await screen.findByText(/end date must be on or after the start date/i),
    ).toBeInTheDocument();
    expect(submitMock).not.toHaveBeenCalled();
  });

  it('shows the buildings widget for stake scope and disables submit when ≥1 not ticked', async () => {
    const user = userEvent.setup();
    render(
      <NewRequestForm
        scopes={[{ value: 'stake', label: 'Stake' }]}
        buildings={buildings()}
        wards={[]}
      />,
    );
    expect(screen.getByTestId('new-request-buildings')).toBeInTheDocument();
    // Stake-scope defaults every building checked (B-11). Untick all so
    // the submit button becomes disabled — the schema's "≥1 building"
    // gate is now expressed at the button level (parity across scopes).
    await user.click(screen.getByTestId('new-request-building-maple'));
    await user.click(screen.getByTestId('new-request-building-cedar'));
    await user.type(screen.getByTestId('new-request-email'), 'bob@example.com');
    await user.type(screen.getByTestId('new-request-name'), 'Bob');
    await user.type(screen.getByTestId('new-request-reason'), 'visit');
    const submitBtn = screen.getByTestId('new-request-submit');
    expect(submitBtn).toBeDisabled();
    await user.click(submitBtn);
    expect(submitMock).not.toHaveBeenCalled();
  });

  it('default-selects the ward building for a single-ward bishopric submitter', async () => {
    const user = userEvent.setup();
    render(
      <NewRequestForm
        scopes={[{ value: 'CO', label: 'Ward CO' }]}
        buildings={buildings()}
        wards={wards([{ code: 'CO', building_name: 'Maple Building' }])}
      />,
    );
    await user.type(screen.getByTestId('new-request-email'), 'bob@example.com');
    await user.type(screen.getByTestId('new-request-name'), 'Bob');
    await user.type(screen.getByTestId('new-request-reason'), 'visit');
    await user.click(screen.getByTestId('new-request-submit'));
    expect(submitMock).toHaveBeenCalledTimes(1);
    expect(submitMock.mock.calls[0]?.[0]).toMatchObject({
      scope: 'CO',
      building_names: ['Maple Building'],
    });
  });

  it('blocks submit (button disabled) when the ward has no building_name and no building is checked', async () => {
    // The empty-state element still renders so the user understands
    // why; submission is gated until they expand the panel and tick at
    // least one building.
    const user = userEvent.setup();
    render(
      <NewRequestForm
        scopes={[{ value: 'CO', label: 'Ward CO' }]}
        buildings={buildings()}
        wards={wards([{ code: 'CO', building_name: '' }])}
      />,
    );
    await user.type(screen.getByTestId('new-request-email'), 'bob@example.com');
    await user.type(screen.getByTestId('new-request-name'), 'Bob');
    await user.type(screen.getByTestId('new-request-reason'), 'visit');
    const submitBtn = screen.getByTestId('new-request-submit');
    expect(submitBtn).toBeDisabled();
    await user.click(submitBtn);
    expect(submitMock).not.toHaveBeenCalled();
  });

  it('submits the cleaned payload when stake-scope add_manual is valid', async () => {
    const user = userEvent.setup();
    render(
      <NewRequestForm
        scopes={[{ value: 'stake', label: 'Stake' }]}
        buildings={buildings()}
        wards={[]}
      />,
    );
    await user.type(screen.getByTestId('new-request-email'), 'Bob@Example.com');
    await user.type(screen.getByTestId('new-request-name'), '  Bob  ');
    await user.type(screen.getByTestId('new-request-reason'), '  visit  ');
    await user.type(screen.getByTestId('new-request-comment'), 'note');
    // Stake-scope defaults every building checked (B-11). Untick Cedar
    // so the manager-narrows-the-grant path is what we lock here.
    await user.click(screen.getByTestId('new-request-building-cedar'));
    await user.click(screen.getByTestId('new-request-submit'));

    expect(submitMock).toHaveBeenCalledTimes(1);
    const call = submitMock.mock.calls[0]?.[0];
    expect(call).toMatchObject({
      type: 'add_manual',
      scope: 'stake',
      member_email: 'Bob@Example.com',
      member_name: 'Bob',
      reason: 'visit',
      comment: 'note',
      building_names: ['Maple Building'],
    });
  });
});

describe('<NewRequestForm /> — buildings selector defaults', () => {
  it('renders expanded with every building pre-checked for a stake-only submitter', () => {
    // B-11 — stake-scope means "everywhere"; the form defaults every
    // building checked. Manager unchecks specific buildings to exclude.
    render(
      <NewRequestForm
        scopes={[{ value: 'stake', label: 'Stake' }]}
        buildings={buildings()}
        wards={[]}
      />,
    );
    const trigger = screen.getByTestId('new-request-buildings-trigger');
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    // Header summary lists every building in catalogue order.
    expect(screen.getByTestId('new-request-buildings-summary')).toHaveTextContent(
      'Buildings: Maple Building, Cedar Building',
    );
    // Both checkboxes visible (panel is expanded) and pre-checked.
    expect(screen.getByTestId('new-request-building-maple')).toBeChecked();
    expect(screen.getByTestId('new-request-building-cedar')).toBeChecked();
  });

  it('renders collapsed with the ward building summary for a single-ward bishopric submitter', () => {
    render(
      <NewRequestForm
        scopes={[{ value: 'CO', label: 'Ward CO' }]}
        buildings={buildings()}
        wards={wards([{ code: 'CO', building_name: 'Maple Building' }])}
      />,
    );
    const trigger = screen.getByTestId('new-request-buildings-trigger');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByTestId('new-request-buildings-summary')).toHaveTextContent(
      'Building: Maple Building',
    );
  });

  it('expands when the trigger is clicked and reveals the full checkbox list with the ward building pre-checked', async () => {
    const user = userEvent.setup();
    render(
      <NewRequestForm
        scopes={[{ value: 'CO', label: 'Ward CO' }]}
        buildings={buildings()}
        wards={wards([{ code: 'CO', building_name: 'Maple Building' }])}
      />,
    );
    const trigger = screen.getByTestId('new-request-buildings-trigger');
    await user.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    // Ward building pre-checked; the other building unchecked but available.
    expect(screen.getByTestId('new-request-building-maple')).toBeChecked();
    expect(screen.getByTestId('new-request-building-cedar')).not.toBeChecked();
  });

  it('preserves selection state across collapse / expand toggles', async () => {
    const user = userEvent.setup();
    render(
      <NewRequestForm
        scopes={[{ value: 'CO', label: 'Ward CO' }]}
        buildings={buildings()}
        wards={wards([{ code: 'CO', building_name: 'Maple Building' }])}
      />,
    );
    const trigger = screen.getByTestId('new-request-buildings-trigger');
    // Expand → tick Cedar as an additional building.
    await user.click(trigger);
    await user.click(screen.getByTestId('new-request-building-cedar'));
    expect(screen.getByTestId('new-request-buildings-summary')).toHaveTextContent(
      'Buildings: Maple Building, Cedar Building',
    );
    // Collapse → header still lists both.
    await user.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByTestId('new-request-buildings-summary')).toHaveTextContent(
      'Buildings: Maple Building, Cedar Building',
    );
    // Re-expand → both still ticked.
    await user.click(trigger);
    expect(screen.getByTestId('new-request-building-maple')).toBeChecked();
    expect(screen.getByTestId('new-request-building-cedar')).toBeChecked();
  });

  it('lets a ward submitter add a second building beyond their ward (the new multi-select capability) when the cross-ward justification comment is filled', async () => {
    // Adding Cedar to a CO request is a cross-ward selection, which
    // gates submit on a non-empty comment (the cross-ward justification
    // rule). With the comment present the submit goes through and
    // carries both building_names.
    const user = userEvent.setup();
    render(
      <NewRequestForm
        scopes={[{ value: 'CO', label: 'Ward CO' }]}
        buildings={buildings()}
        wards={wards([{ code: 'CO', building_name: 'Maple Building' }])}
      />,
    );
    await user.click(screen.getByTestId('new-request-buildings-trigger'));
    await user.click(screen.getByTestId('new-request-building-cedar'));
    await user.type(screen.getByTestId('new-request-email'), 'bob@example.com');
    await user.type(screen.getByTestId('new-request-name'), 'Bob');
    await user.type(screen.getByTestId('new-request-reason'), 'visit');
    await user.type(
      screen.getByTestId('new-request-comment'),
      'Helping a member from the next ward over.',
    );
    await user.click(screen.getByTestId('new-request-submit'));
    expect(submitMock).toHaveBeenCalledTimes(1);
    expect(submitMock.mock.calls[0]?.[0]).toMatchObject({
      scope: 'CO',
      building_names: ['Maple Building', 'Cedar Building'],
    });
  });

  it('lets a ward submitter deselect their default ward building', async () => {
    const user = userEvent.setup();
    render(
      <NewRequestForm
        scopes={[{ value: 'CO', label: 'Ward CO' }]}
        buildings={buildings()}
        wards={wards([{ code: 'CO', building_name: 'Maple Building' }])}
      />,
    );
    await user.click(screen.getByTestId('new-request-buildings-trigger'));
    // Untick the pre-selected ward building.
    await user.click(screen.getByTestId('new-request-building-maple'));
    expect(screen.getByTestId('new-request-building-maple')).not.toBeChecked();
    expect(screen.getByTestId('new-request-buildings-summary')).toHaveTextContent(/none selected/i);
  });

  it('lets a stake user collapse the panel even though the role default is expanded', async () => {
    const user = userEvent.setup();
    render(
      <NewRequestForm
        scopes={[{ value: 'stake', label: 'Stake' }]}
        buildings={buildings()}
        wards={[]}
      />,
    );
    const trigger = screen.getByTestId('new-request-buildings-trigger');
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await user.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });
});

describe('<NewRequestForm /> — B-11 stake-scope all-buildings default', () => {
  // B-11 — picking `scope === 'stake'` defaults building_names to the
  // stake's full building list (was: []). Manager unchecks specific
  // buildings to exclude; previously had to tick every building by
  // hand for an N-building stake.

  it('initialises building_names to the full catalogue when the form mounts in stake scope', async () => {
    const user = userEvent.setup();
    render(
      <NewRequestForm
        scopes={[{ value: 'stake', label: 'Stake' }]}
        buildings={buildings()}
        wards={[]}
      />,
    );
    // Submit straight away — no manual building clicks. The default
    // payload must carry every building_name in the catalogue.
    await user.type(screen.getByTestId('new-request-email'), 'bob@example.com');
    await user.type(screen.getByTestId('new-request-name'), 'Bob');
    await user.type(screen.getByTestId('new-request-reason'), 'visit');
    await user.click(screen.getByTestId('new-request-submit'));
    expect(submitMock).toHaveBeenCalledTimes(1);
    expect(submitMock.mock.calls[0]?.[0]).toMatchObject({
      scope: 'stake',
      building_names: ['Maple Building', 'Cedar Building'],
    });
  });
});

describe('<NewRequestForm /> — urgent flag', () => {
  it('renders the Emergency? checkbox above the submit button', () => {
    render(
      <NewRequestForm
        scopes={[{ value: 'CO', label: 'Ward CO' }]}
        buildings={buildings()}
        wards={wards([{ code: 'CO', building_name: 'Maple Building' }])}
      />,
    );
    expect(screen.getByTestId('new-request-urgent')).toBeInTheDocument();
  });

  it('reveals the red helper text only when urgent is checked', async () => {
    const user = userEvent.setup();
    render(
      <NewRequestForm
        scopes={[{ value: 'CO', label: 'Ward CO' }]}
        buildings={buildings()}
        wards={wards([{ code: 'CO', building_name: 'Maple Building' }])}
      />,
    );
    expect(screen.queryByTestId('new-request-urgent-hint')).toBeNull();
    await user.click(screen.getByTestId('new-request-urgent'));
    expect(screen.getByTestId('new-request-urgent-hint')).toBeInTheDocument();
  });

  it('blocks submit on empty comment when urgent is checked', async () => {
    const user = userEvent.setup();
    render(
      <NewRequestForm
        scopes={[{ value: 'CO', label: 'Ward CO' }]}
        buildings={buildings()}
        wards={wards([{ code: 'CO', building_name: 'Maple Building' }])}
      />,
    );
    await user.type(screen.getByTestId('new-request-email'), 'bob@example.com');
    await user.type(screen.getByTestId('new-request-name'), 'Bob');
    await user.type(screen.getByTestId('new-request-reason'), 'visit');
    await user.click(screen.getByTestId('new-request-urgent'));
    await user.click(screen.getByTestId('new-request-submit'));
    // Inline form error suppressed; the right-aligned helper under the
    // Emergency? checkbox already conveys "comment required". Submit is
    // still gated by the schema; assert only the observable.
    expect(submitMock).not.toHaveBeenCalled();
  });

  it('passes urgent=true through to the submit mutation', async () => {
    const user = userEvent.setup();
    render(
      <NewRequestForm
        scopes={[{ value: 'CO', label: 'Ward CO' }]}
        buildings={buildings()}
        wards={wards([{ code: 'CO', building_name: 'Maple Building' }])}
      />,
    );
    await user.type(screen.getByTestId('new-request-email'), 'bob@example.com');
    await user.type(screen.getByTestId('new-request-name'), 'Bob');
    await user.type(screen.getByTestId('new-request-reason'), 'visit');
    await user.type(screen.getByTestId('new-request-comment'), 'covering for sub teacher');
    await user.click(screen.getByTestId('new-request-urgent'));
    await user.click(screen.getByTestId('new-request-submit'));
    expect(submitMock).toHaveBeenCalledTimes(1);
    expect(submitMock.mock.calls[0]?.[0]).toMatchObject({ urgent: true });
  });

  it('passes urgent=false (default) when the box is not checked', async () => {
    const user = userEvent.setup();
    render(
      <NewRequestForm
        scopes={[{ value: 'CO', label: 'Ward CO' }]}
        buildings={buildings()}
        wards={wards([{ code: 'CO', building_name: 'Maple Building' }])}
      />,
    );
    await user.type(screen.getByTestId('new-request-email'), 'bob@example.com');
    await user.type(screen.getByTestId('new-request-name'), 'Bob');
    await user.type(screen.getByTestId('new-request-reason'), 'visit');
    await user.click(screen.getByTestId('new-request-submit'));
    expect(submitMock).toHaveBeenCalledTimes(1);
    expect(submitMock.mock.calls[0]?.[0]).toMatchObject({ urgent: false });
  });
});

describe('<NewRequestForm /> — cross-ward comment-required rule', () => {
  // Ward-scope submissions touching any building outside the ward's
  // own default building set must carry a non-empty comment. The
  // form (a) flips the comment label between (optional) and (required)
  // reactively and (b) blocks submit with an inline error otherwise.
  // Stake-scope submissions are unaffected (urgent-required is the
  // only comment gate there).

  it('shows "(optional)" on a ward-scope submission that stays inside the default building set', () => {
    render(
      <NewRequestForm
        scopes={[{ value: 'CO', label: 'Ward CO' }]}
        buildings={buildings()}
        wards={wards([{ code: 'CO', building_name: 'Maple Building' }])}
      />,
    );
    expect(screen.getByTestId('new-request-comment-marker')).toHaveTextContent(/optional/i);
  });

  it('flips the comment marker to "(required)" when the user adds a non-default building', async () => {
    const user = userEvent.setup();
    render(
      <NewRequestForm
        scopes={[{ value: 'CO', label: 'Ward CO' }]}
        buildings={buildings()}
        wards={wards([{ code: 'CO', building_name: 'Maple Building' }])}
      />,
    );
    await user.click(screen.getByTestId('new-request-buildings-trigger'));
    await user.click(screen.getByTestId('new-request-building-cedar'));
    expect(screen.getByTestId('new-request-comment-marker')).toHaveTextContent(/required/i);
  });

  it('flips the marker back to "(optional)" when the user unticks the cross-ward building', async () => {
    const user = userEvent.setup();
    render(
      <NewRequestForm
        scopes={[{ value: 'CO', label: 'Ward CO' }]}
        buildings={buildings()}
        wards={wards([{ code: 'CO', building_name: 'Maple Building' }])}
      />,
    );
    await user.click(screen.getByTestId('new-request-buildings-trigger'));
    await user.click(screen.getByTestId('new-request-building-cedar'));
    expect(screen.getByTestId('new-request-comment-marker')).toHaveTextContent(/required/i);
    await user.click(screen.getByTestId('new-request-building-cedar'));
    expect(screen.getByTestId('new-request-comment-marker')).toHaveTextContent(/optional/i);
  });

  it('blocks submit with an inline error when a cross-ward selection is missing the comment', async () => {
    const user = userEvent.setup();
    render(
      <NewRequestForm
        scopes={[{ value: 'CO', label: 'Ward CO' }]}
        buildings={buildings()}
        wards={wards([{ code: 'CO', building_name: 'Maple Building' }])}
      />,
    );
    await user.click(screen.getByTestId('new-request-buildings-trigger'));
    await user.click(screen.getByTestId('new-request-building-cedar'));
    await user.type(screen.getByTestId('new-request-email'), 'bob@example.com');
    await user.type(screen.getByTestId('new-request-name'), 'Bob');
    await user.type(screen.getByTestId('new-request-reason'), 'visit');
    await user.click(screen.getByTestId('new-request-submit'));
    expect(
      await screen.findByText(/comment is required when requesting buildings outside the ward/i),
    ).toBeInTheDocument();
    expect(submitMock).not.toHaveBeenCalled();
  });

  it('admits the submit once the comment is filled', async () => {
    const user = userEvent.setup();
    render(
      <NewRequestForm
        scopes={[{ value: 'CO', label: 'Ward CO' }]}
        buildings={buildings()}
        wards={wards([{ code: 'CO', building_name: 'Maple Building' }])}
      />,
    );
    await user.click(screen.getByTestId('new-request-buildings-trigger'));
    await user.click(screen.getByTestId('new-request-building-cedar'));
    await user.type(screen.getByTestId('new-request-email'), 'bob@example.com');
    await user.type(screen.getByTestId('new-request-name'), 'Bob');
    await user.type(screen.getByTestId('new-request-reason'), 'visit');
    await user.type(screen.getByTestId('new-request-comment'), 'cross-ward justification');
    await user.click(screen.getByTestId('new-request-submit'));
    expect(submitMock).toHaveBeenCalledTimes(1);
  });

  it('does not gate stake-scope submissions on a comment regardless of building selection', async () => {
    const user = userEvent.setup();
    render(
      <NewRequestForm
        scopes={[{ value: 'stake', label: 'Stake' }]}
        buildings={buildings()}
        wards={[]}
      />,
    );
    // Stake-scope defaults every building checked (B-11). Comment is
    // optional regardless of which buildings are ticked.
    expect(screen.getByTestId('new-request-comment-marker')).toHaveTextContent(/optional/i);
    await user.click(screen.getByTestId('new-request-building-cedar'));
    expect(screen.getByTestId('new-request-comment-marker')).toHaveTextContent(/optional/i);
    await user.type(screen.getByTestId('new-request-email'), 'bob@example.com');
    await user.type(screen.getByTestId('new-request-name'), 'Bob');
    await user.type(screen.getByTestId('new-request-reason'), 'visit');
    await user.click(screen.getByTestId('new-request-submit'));
    expect(submitMock).toHaveBeenCalledTimes(1);
  });
});

describe('<NewRequestForm /> — calling typeahead', () => {
  // The `reason` field is now a scope-aware combobox. Suggestions come
  // from `WARD_CALLINGS` (ward scope) or `STAKE_CALLINGS` (stake scope);
  // free-text values outside the lists still submit unchanged.

  it('renders the label as "Calling" when type is add_manual', () => {
    render(
      <NewRequestForm
        scopes={[{ value: 'CO', label: 'Ward CO' }]}
        buildings={buildings()}
        wards={wards([{ code: 'CO', building_name: 'Maple Building' }])}
      />,
    );
    const label = screen.getByText(/^Calling$/);
    expect(label).toBeInTheDocument();
  });

  it('suggests ward callings when the scope is a ward', async () => {
    const user = userEvent.setup();
    render(
      <NewRequestForm
        scopes={[{ value: 'CO', label: 'Ward CO' }]}
        buildings={buildings()}
        wards={wards([{ code: 'CO', building_name: 'Maple Building' }])}
      />,
    );
    await user.click(screen.getByTestId('new-request-reason'));
    // Sample two entries from the ward list — exhaustive enumeration
    // would add no signal.
    expect(await screen.findByText('Bishop')).toBeInTheDocument();
    expect(screen.getByText('Elders Quorum President')).toBeInTheDocument();
  });

  it('suggests stake callings when the scope is stake', async () => {
    const user = userEvent.setup();
    render(
      <NewRequestForm
        scopes={[{ value: 'stake', label: 'Stake' }]}
        buildings={buildings()}
        wards={[]}
      />,
    );
    await user.click(screen.getByTestId('new-request-reason'));
    expect(await screen.findByText('Stake President')).toBeInTheDocument();
    expect(screen.getByText('Stake High Councilor')).toBeInTheDocument();
  });

  it('filters suggestions as the user types', async () => {
    const user = userEvent.setup();
    render(
      <NewRequestForm
        scopes={[{ value: 'CO', label: 'Ward CO' }]}
        buildings={buildings()}
        wards={wards([{ code: 'CO', building_name: 'Maple Building' }])}
      />,
    );
    const reason = screen.getByTestId('new-request-reason');
    await user.click(reason);
    await user.type(reason, 'bishop');
    expect(await screen.findByText('Bishop')).toBeInTheDocument();
    expect(screen.getByText('Bishopric First Counselor')).toBeInTheDocument();
    expect(screen.getByText('Bishopric Second Counselor')).toBeInTheDocument();
    // Unrelated callings filtered out.
    expect(screen.queryByText('Relief Society President')).toBeNull();
    expect(screen.queryByText('Sunday School President')).toBeNull();
  });

  it('selecting a suggestion populates the field with the exact calling', async () => {
    const user = userEvent.setup();
    render(
      <NewRequestForm
        scopes={[{ value: 'CO', label: 'Ward CO' }]}
        buildings={buildings()}
        wards={wards([{ code: 'CO', building_name: 'Maple Building' }])}
      />,
    );
    const reason = screen.getByTestId('new-request-reason') as HTMLInputElement;
    await user.click(reason);
    await user.type(reason, 'sunday');
    const option = await screen.findByText('Sunday School President');
    await user.click(option);
    expect(reason.value).toBe('Sunday School President');
  });

  it('shows the CommandEmpty message when nothing matches', async () => {
    const user = userEvent.setup();
    render(
      <NewRequestForm
        scopes={[{ value: 'CO', label: 'Ward CO' }]}
        buildings={buildings()}
        wards={wards([{ code: 'CO', building_name: 'Maple Building' }])}
      />,
    );
    const reason = screen.getByTestId('new-request-reason');
    await user.click(reason);
    await user.type(reason, 'xyzzy-no-such-calling');
    expect(
      await screen.findByText(/no matching calling\. free-text reason will be saved\./i),
    ).toBeInTheDocument();
  });

  it('submits the typed value verbatim when it does not match any suggestion', async () => {
    const user = userEvent.setup();
    render(
      <NewRequestForm
        scopes={[{ value: 'stake', label: 'Stake' }]}
        buildings={buildings()}
        wards={[]}
      />,
    );
    await user.type(screen.getByTestId('new-request-email'), 'bob@example.com');
    await user.type(screen.getByTestId('new-request-name'), 'Bob');
    await user.click(screen.getByTestId('new-request-reason'));
    await user.type(
      screen.getByTestId('new-request-reason'),
      'Stake Music Coordinator-EQ Quorum Liaison',
    );
    await user.click(screen.getByTestId('new-request-submit'));
    expect(submitMock).toHaveBeenCalledTimes(1);
    expect(submitMock.mock.calls[0]?.[0]).toMatchObject({
      reason: 'Stake Music Coordinator-EQ Quorum Liaison',
    });
  });
});

describe('<NewRequestForm /> — reason field is type-conditional', () => {
  // add_manual → typeahead Combobox + "Calling" label.
  // add_temp  → plain text input + "Reason" label (no suggestions).
  // Switching type preserves the typed value.

  it('renders the label as "Reason" when type is add_temp', async () => {
    const user = userEvent.setup();
    render(
      <NewRequestForm
        scopes={[{ value: 'CO', label: 'Ward CO' }]}
        buildings={buildings()}
        wards={wards([{ code: 'CO', building_name: 'Maple Building' }])}
      />,
    );
    await user.selectOptions(screen.getByTestId('new-request-type'), 'add_temp');
    expect(screen.getByText(/^Reason$/)).toBeInTheDocument();
    // The manual-mode label is gone.
    expect(screen.queryByText(/^Calling$/)).toBeNull();
  });

  it('renders a plain input (no Combobox popover) when type is add_temp', async () => {
    const user = userEvent.setup();
    render(
      <NewRequestForm
        scopes={[{ value: 'CO', label: 'Ward CO' }]}
        buildings={buildings()}
        wards={wards([{ code: 'CO', building_name: 'Maple Building' }])}
      />,
    );
    await user.selectOptions(screen.getByTestId('new-request-type'), 'add_temp');
    const reason = screen.getByTestId('new-request-reason') as HTMLInputElement;
    await user.click(reason);
    await user.type(reason, 'Bishop');
    // No cmdk listbox / suggestion items — even a query that would
    // match a known calling shows nothing.
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(screen.queryByText('Bishop')).toBeNull();
    expect(screen.queryByText('Bishopric First Counselor')).toBeNull();
    // The Combobox empty-state message is also absent.
    expect(
      screen.queryByText(/no matching calling\. free-text reason will be saved\./i),
    ).toBeNull();
  });

  it('preserves the typed value when switching add_manual → add_temp → add_manual', async () => {
    const user = userEvent.setup();
    render(
      <NewRequestForm
        scopes={[{ value: 'CO', label: 'Ward CO' }]}
        buildings={buildings()}
        wards={wards([{ code: 'CO', building_name: 'Maple Building' }])}
      />,
    );
    // Mount in manual mode — select a suggestion to seed the field.
    const reason = screen.getByTestId('new-request-reason') as HTMLInputElement;
    await user.click(reason);
    await user.type(reason, 'sunday');
    const option = await screen.findByText('Sunday School President');
    await user.click(option);
    expect(reason.value).toBe('Sunday School President');

    // Switch to add_temp — value survives the swap to plain input.
    await user.selectOptions(screen.getByTestId('new-request-type'), 'add_temp');
    const reasonTemp = screen.getByTestId('new-request-reason') as HTMLInputElement;
    expect(reasonTemp.value).toBe('Sunday School President');

    // Switch back to add_manual — value still there and suggestions
    // available again. Clear the filter and re-focus so the list shows
    // the ward callings unfiltered.
    await user.selectOptions(screen.getByTestId('new-request-type'), 'add_manual');
    const reasonBack = screen.getByTestId('new-request-reason') as HTMLInputElement;
    expect(reasonBack.value).toBe('Sunday School President');
    await user.click(reasonBack);
    await user.clear(reasonBack);
    // Typing a letter from the ward list re-opens the popover with
    // matching suggestions; the typed-and-cleared sequence above proved
    // the field is editable post-switch.
    await user.type(reasonBack, 'b');
    expect(await screen.findByText('Bishop')).toBeInTheDocument();
  });
});

describe('<NewRequestForm /> — duplicate error', () => {
  it('renders the error when the live seat hook returns a hit in the same scope', async () => {
    const user = userEvent.setup();
    useSeatForMemberMock.mockReturnValue(
      liveSeatResult({
        member_canonical: 'bob@example.com',
        member_email: 'bob@example.com',
        member_name: 'Bob',
        scope: 'stake',
        type: 'manual',
        callings: [],
        building_names: [],
        duplicate_grants: [],
        created_at: { seconds: 0, nanoseconds: 0, toDate: () => new Date(), toMillis: () => 0 },
        last_modified_at: {
          seconds: 0,
          nanoseconds: 0,
          toDate: () => new Date(),
          toMillis: () => 0,
        },
        last_modified_by: { email: 'a@b.c', canonical: 'a@b.c' },
        lastActor: { email: 'a@b.c', canonical: 'a@b.c' },
      } as Seat),
    );
    render(
      <NewRequestForm
        scopes={[{ value: 'stake', label: 'Stake' }]}
        buildings={buildings()}
        wards={[]}
      />,
    );
    await user.type(screen.getByTestId('new-request-email'), 'bob@example.com');
    expect(await screen.findByTestId('new-request-duplicate-error')).toBeInTheDocument();
  });

  it('does not error when the seat is in a different scope', async () => {
    const user = userEvent.setup();
    useSeatForMemberMock.mockReturnValue(
      liveSeatResult({
        member_canonical: 'bob@example.com',
        member_email: 'bob@example.com',
        member_name: 'Bob',
        scope: 'GE',
        type: 'auto',
        callings: ['Bishop'],
        building_names: [],
        duplicate_grants: [],
        created_at: { seconds: 0, nanoseconds: 0, toDate: () => new Date(), toMillis: () => 0 },
        last_modified_at: {
          seconds: 0,
          nanoseconds: 0,
          toDate: () => new Date(),
          toMillis: () => 0,
        },
        last_modified_by: { email: 'a@b.c', canonical: 'a@b.c' },
        lastActor: { email: 'a@b.c', canonical: 'a@b.c' },
      } as Seat),
    );
    render(
      <NewRequestForm
        scopes={[{ value: 'stake', label: 'Stake' }]}
        buildings={buildings()}
        wards={[]}
      />,
    );
    await user.type(screen.getByTestId('new-request-email'), 'bob@example.com');
    expect(screen.queryByTestId('new-request-duplicate-error')).toBeNull();
  });

  it('disables Submit and blocks the mutation on a same-scope dup hit', async () => {
    const user = userEvent.setup();
    useSeatForMemberMock.mockReturnValue(
      liveSeatResult({
        member_canonical: 'bob@example.com',
        member_email: 'bob@example.com',
        member_name: 'Bob',
        scope: 'CO',
        type: 'manual',
        callings: [],
        building_names: [],
        duplicate_grants: [],
        created_at: { seconds: 0, nanoseconds: 0, toDate: () => new Date(), toMillis: () => 0 },
        last_modified_at: {
          seconds: 0,
          nanoseconds: 0,
          toDate: () => new Date(),
          toMillis: () => 0,
        },
        last_modified_by: { email: 'a@b.c', canonical: 'a@b.c' },
        lastActor: { email: 'a@b.c', canonical: 'a@b.c' },
      } as Seat),
    );
    render(
      <NewRequestForm
        scopes={[{ value: 'CO', label: 'Ward CO' }]}
        buildings={buildings()}
        wards={wards([{ code: 'CO', building_name: 'Maple Building' }])}
      />,
    );
    // Fill in every other required field so the dup hit is the only gate
    // standing between the form and a valid submission.
    await user.type(screen.getByTestId('new-request-email'), 'bob@example.com');
    await user.type(screen.getByTestId('new-request-name'), 'Bob');
    await user.type(screen.getByTestId('new-request-reason'), 'visit');
    // The dup error is live and the ward default building is ticked.
    expect(await screen.findByTestId('new-request-duplicate-error')).toBeInTheDocument();
    const submitBtn = screen.getByTestId('new-request-submit');
    expect(submitBtn).toBeDisabled();
    await user.click(submitBtn);
    expect(submitMock).not.toHaveBeenCalled();
  });
});

describe('<NewRequestForm /> — empty-buildings submit gate', () => {
  // Parity rule with stake scope: ward-scope submissions also require
  // ≥1 building. Submit is gated at the button level so the user can't
  // ship a building_names: [] payload regardless of how they reached
  // that state (untick the ward default, no ward.building_name in the
  // catalogue, site filter clamps the default to empty).

  it('disables the submit button on ward scope when the user unticks the ward default', async () => {
    const user = userEvent.setup();
    render(
      <NewRequestForm
        scopes={[{ value: 'CO', label: 'Ward CO' }]}
        buildings={buildings()}
        wards={wards([{ code: 'CO', building_name: 'Maple Building' }])}
      />,
    );
    await user.click(screen.getByTestId('new-request-buildings-trigger'));
    await user.click(screen.getByTestId('new-request-building-maple'));
    expect(screen.getByTestId('new-request-building-maple')).not.toBeChecked();
    const submitBtn = screen.getByTestId('new-request-submit');
    expect(submitBtn).toBeDisabled();
    await user.type(screen.getByTestId('new-request-email'), 'bob@example.com');
    await user.type(screen.getByTestId('new-request-name'), 'Bob');
    await user.type(screen.getByTestId('new-request-reason'), 'visit');
    await user.click(submitBtn);
    expect(submitMock).not.toHaveBeenCalled();
  });

  it('re-enables the submit button once a ward submitter ticks at least one building', async () => {
    const user = userEvent.setup();
    render(
      <NewRequestForm
        scopes={[{ value: 'CO', label: 'Ward CO' }]}
        buildings={buildings()}
        wards={wards([{ code: 'CO', building_name: '' }])}
      />,
    );
    // Ward has no building_name → no default ticked, submit disabled.
    const submitBtn = screen.getByTestId('new-request-submit');
    expect(submitBtn).toBeDisabled();
    // Expand the panel and tick a building.
    await user.click(screen.getByTestId('new-request-buildings-trigger'));
    await user.click(screen.getByTestId('new-request-building-maple'));
    expect(submitBtn).not.toBeDisabled();
  });
});

describe('<NewRequestForm /> — Kindoo Sites building filter (spec §15)', () => {
  // Phase 2 narrows the building checklist to the buildings whose
  // `kindoo_site_id` matches the current scope's Kindoo site.
  //   - Stake scope → home buildings only (foreign sites are out of
  //     scope for stake-wide presidency / clerks per spec §15).
  //   - Ward scope (home) → home buildings only.
  //   - Ward scope (foreign site `foreign-1`) → buildings tagged
  //     `foreign-1` only. The ward's own home building is hidden.
  //   - Empty filter (e.g., foreign ward with no foreign building
  //     configured yet) → explicit empty-state, no crash.

  it('filters the stake-scope checklist to home-site buildings only (foreign building hidden)', () => {
    // Mixed catalogue: one home building, one foreign-site building.
    // Stake scope expands the panel and pre-checks every visible
    // building (B-11) — but only the home building is visible.
    render(
      <NewRequestForm
        scopes={[{ value: 'stake', label: 'Stake' }]}
        buildings={buildingsWithSites([
          { id: 'maple', name: 'Maple Building', kindoo_site_id: null },
          { id: 'pine', name: 'Pine Building', kindoo_site_id: 'foreign-1' },
        ])}
        wards={[]}
      />,
    );
    // The foreign building's checkbox is absent from the rendered list.
    expect(screen.getByTestId('new-request-building-maple')).toBeInTheDocument();
    expect(screen.queryByTestId('new-request-building-pine')).toBeNull();
    // Header summary reflects only the home building.
    expect(screen.getByTestId('new-request-buildings-summary')).toHaveTextContent(
      'Building: Maple Building',
    );
  });

  it('treats legacy buildings without kindoo_site_id as home (stake scope sees them)', () => {
    render(
      <NewRequestForm
        scopes={[{ value: 'stake', label: 'Stake' }]}
        // No kindoo_site_id field — legacy data; should land as home.
        buildings={buildingsWithSites([
          { id: 'maple', name: 'Maple Building' },
          { id: 'pine', name: 'Pine Building', kindoo_site_id: 'foreign-1' },
        ])}
        wards={[]}
      />,
    );
    expect(screen.getByTestId('new-request-building-maple')).toBeInTheDocument();
    expect(screen.queryByTestId('new-request-building-pine')).toBeNull();
  });

  it('filters a foreign-ward-scope checklist to the matching foreign-site buildings only', async () => {
    // Ward FN lives on foreign site `foreign-1`. The checklist shows
    // foreign-1 buildings only; the home building Maple is hidden.
    const user = userEvent.setup();
    render(
      <NewRequestForm
        scopes={[{ value: 'FN', label: 'Ward FN' }]}
        buildings={buildingsWithSites([
          { id: 'maple', name: 'Maple Building', kindoo_site_id: null },
          { id: 'pine', name: 'Pine Building', kindoo_site_id: 'foreign-1' },
        ])}
        wards={wards([{ code: 'FN', building_name: 'Pine Building', kindoo_site_id: 'foreign-1' }])}
      />,
    );
    await user.click(screen.getByTestId('new-request-buildings-trigger'));
    expect(screen.getByTestId('new-request-building-pine')).toBeInTheDocument();
    expect(screen.queryByTestId('new-request-building-maple')).toBeNull();
    // Ward's home building pre-checked.
    expect(screen.getByTestId('new-request-building-pine')).toBeChecked();
  });

  it('renders an empty-state message when the site filter narrows the catalogue to zero', () => {
    // Ward FN resolves to the home site (its building isn't configured
    // yet), but no home building exists — only a foreign one. The
    // home-filtered visible set is empty. The collapsible expands
    // manually so the empty-state is observable.
    render(
      <NewRequestForm
        scopes={[{ value: 'FN', label: 'Ward FN' }]}
        // Only a foreign building exists; nothing on the home site.
        buildings={buildingsWithSites([
          { id: 'pine', name: 'Pine Building', kindoo_site_id: 'foreign-1' },
        ])}
        wards={wards([{ code: 'FN', building_name: '' }])}
      />,
    );
    // The collapsible defaults to closed for ward scopes; force-expand
    // via the trigger to inspect the empty-state.
    return userEvent
      .setup()
      .click(screen.getByTestId('new-request-buildings-trigger'))
      .then(() => {
        expect(screen.getByTestId('new-request-buildings-empty-for-scope')).toBeInTheDocument();
        // The home-only "no buildings configured" message stays hidden
        // — it's a different empty-state with different copy.
        expect(screen.queryByTestId('new-request-buildings-empty')).toBeNull();
      });
  });

  it('drops a ward default building that is hidden by the site filter from the pre-checked defaults', async () => {
    // Risk 2 (legacy / mid-migration state): ward FN references a
    // building ('Ghost Building') that isn't in the catalogue, so the
    // ward resolves to the home site. The only configured building is
    // on a foreign site, so the home-filtered visible set is empty. The
    // form must NOT pre-check the ward's (hidden) default building and
    // must NOT ship it on submit, landing with zero pre-checked
    // buildings and a disabled submit.
    render(
      <NewRequestForm
        scopes={[{ value: 'FN', label: 'Ward FN' }]}
        buildings={buildingsWithSites([
          { id: 'pine', name: 'Pine Building', kindoo_site_id: 'foreign-1' },
        ])}
        wards={wards([{ code: 'FN', building_name: 'Ghost Building' }])}
      />,
    );
    // Header summary reflects no selection (the hidden pre-check was
    // dropped). Submit is disabled.
    expect(screen.getByTestId('new-request-buildings-summary')).toHaveTextContent(/none selected/i);
    expect(screen.getByTestId('new-request-submit')).toBeDisabled();
  });

  it('renders only the foreign-site buildings for a foreign-ward scope', async () => {
    // The visible building set is derived from the launched scope. A
    // foreign-ward scope narrows the checklist to that site's buildings;
    // the home building is hidden.
    const user = userEvent.setup();
    render(
      <NewRequestForm
        scopes={[{ value: 'FN', label: 'Ward FN' }]}
        buildings={buildingsWithSites([
          { id: 'maple', name: 'Maple Building', kindoo_site_id: null },
          { id: 'pine', name: 'Pine Building', kindoo_site_id: 'foreign-1' },
        ])}
        wards={wards([{ code: 'FN', building_name: 'Pine Building', kindoo_site_id: 'foreign-1' }])}
      />,
    );
    await user.click(screen.getByTestId('new-request-buildings-trigger'));
    expect(screen.getByTestId('new-request-building-pine')).toBeInTheDocument();
    expect(screen.queryByTestId('new-request-building-maple')).toBeNull();
  });
});

describe('<NewRequestForm /> — dialog mode', () => {
  // Dialog mode is keyed off `onSubmitted` being supplied. The actions
  // then render inside a Dialog.Footer (Cancel + Submit); a successful
  // submit calls `onSubmitted` (the dialog closes + unmounts the form,
  // so no post-submit reset) and Cancel calls `onCancel` without
  // submitting. Page mode (both props omitted) is unchanged and covered
  // by the rest of this file. The footer's Cancel button wraps
  // Radix's Dialog.Close, which requires a Dialog Root ancestor — so
  // dialog-mode renders wrap the form in a real <Dialog>.

  function renderDialogMode(props: {
    onSubmitted: () => void;
    onCancel: () => void;
    scopes?: { value: string; label: string }[];
  }) {
    const scopes = props.scopes ?? [{ value: 'CO', label: 'Ward CO' }];
    return render(
      <Dialog open onOpenChange={() => {}} title="New Request">
        <NewRequestForm
          scopes={scopes}
          buildings={buildings()}
          wards={wards([{ code: 'CO', building_name: 'Maple Building' }])}
          onSubmitted={props.onSubmitted}
          onCancel={props.onCancel}
        />
      </Dialog>,
    );
  }

  it('renders a Cancel button in dialog mode', () => {
    renderDialogMode({ onSubmitted: () => {}, onCancel: () => {} });
    expect(screen.getByTestId('new-request-cancel')).toBeInTheDocument();
  });

  it('does not render a Cancel button in page mode', () => {
    render(
      <NewRequestForm
        scopes={[{ value: 'CO', label: 'Ward CO' }]}
        buildings={buildings()}
        wards={wards([{ code: 'CO', building_name: 'Maple Building' }])}
      />,
    );
    expect(screen.queryByTestId('new-request-cancel')).toBeNull();
  });

  it('calls onSubmitted on a successful submit', async () => {
    const user = userEvent.setup();
    const onSubmitted = vi.fn();
    renderDialogMode({ onSubmitted, onCancel: () => {} });
    await user.type(screen.getByTestId('new-request-email'), 'bob@example.com');
    await user.type(screen.getByTestId('new-request-name'), 'Bob');
    await user.type(screen.getByTestId('new-request-reason'), 'visit');
    await user.click(screen.getByTestId('new-request-submit'));
    expect(submitMock).toHaveBeenCalledTimes(1);
    expect(onSubmitted).toHaveBeenCalledTimes(1);
  });

  it('calls onCancel and does not submit when Cancel is clicked', async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    renderDialogMode({ onSubmitted: () => {}, onCancel });
    await user.click(screen.getByTestId('new-request-cancel'));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(submitMock).not.toHaveBeenCalled();
  });
});

describe('<NewRequestForm /> — organization selector (stake scope only)', () => {
  it('does not render the org Select for a ward-scope form', () => {
    useOrganizationsMock.mockReturnValue(
      liveOrgResult(organizations([{ id: 'scouts', name: 'Scouts' }])),
    );
    render(
      <NewRequestForm
        scopes={[{ value: 'CO', label: 'Ward CO' }]}
        buildings={buildings()}
        wards={wards([{ code: 'CO', building_name: 'Maple Building' }])}
      />,
    );
    expect(screen.queryByTestId('new-request-organization')).toBeNull();
  });

  it('renders the org Select for a stake-scope form', () => {
    useOrganizationsMock.mockReturnValue(
      liveOrgResult(organizations([{ id: 'scouts', name: 'Scouts' }])),
    );
    render(
      <NewRequestForm
        scopes={[{ value: 'stake', label: 'Stake' }]}
        buildings={buildings()}
        wards={[]}
      />,
    );
    expect(screen.getByTestId('new-request-organization')).toBeInTheDocument();
  });

  it('defaults to "No Organization" and lists each org sorted by name', () => {
    useOrganizationsMock.mockReturnValue(
      liveOrgResult(
        organizations([
          { id: 'scouts', name: 'Scouts' },
          { id: 'primary-children', name: 'Primary Children' },
        ]),
      ),
    );
    render(
      <NewRequestForm
        scopes={[{ value: 'stake', label: 'Stake' }]}
        buildings={buildings()}
        wards={[]}
      />,
    );
    const select = screen.getByTestId('new-request-organization') as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.text)).toEqual([
      'No Organization',
      'Primary Children',
      'Scouts',
    ]);
    // Default lands on "No Organization".
    expect(select.options[select.selectedIndex]!.text).toBe('No Organization');
  });

  it('submits the chosen organization_id for a stake-scope request', async () => {
    const user = userEvent.setup();
    useOrganizationsMock.mockReturnValue(
      liveOrgResult(organizations([{ id: 'primary-children', name: 'Primary Children' }])),
    );
    render(
      <NewRequestForm
        scopes={[{ value: 'stake', label: 'Stake' }]}
        buildings={buildings()}
        wards={[]}
      />,
    );
    await user.selectOptions(screen.getByTestId('new-request-organization'), 'primary-children');
    await user.type(screen.getByTestId('new-request-email'), 'bob@example.com');
    await user.type(screen.getByTestId('new-request-name'), 'Bob');
    await user.type(screen.getByTestId('new-request-reason'), 'visit');
    await user.click(screen.getByTestId('new-request-submit'));
    expect(submitMock).toHaveBeenCalledTimes(1);
    expect(submitMock.mock.calls[0]?.[0]).toMatchObject({
      scope: 'stake',
      organization_id: 'primary-children',
    });
  });

  it('submits organization_id=null when "No Organization" is left selected', async () => {
    const user = userEvent.setup();
    useOrganizationsMock.mockReturnValue(
      liveOrgResult(organizations([{ id: 'primary-children', name: 'Primary Children' }])),
    );
    render(
      <NewRequestForm
        scopes={[{ value: 'stake', label: 'Stake' }]}
        buildings={buildings()}
        wards={[]}
      />,
    );
    await user.type(screen.getByTestId('new-request-email'), 'bob@example.com');
    await user.type(screen.getByTestId('new-request-name'), 'Bob');
    await user.type(screen.getByTestId('new-request-reason'), 'visit');
    await user.click(screen.getByTestId('new-request-submit'));
    expect(submitMock).toHaveBeenCalledTimes(1);
    expect(submitMock.mock.calls[0]?.[0]).toMatchObject({
      scope: 'stake',
      organization_id: null,
    });
  });
});
