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
//   - Duplicate-warning surfaces when the live seat hook returns a
//     hit in the same scope.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Building, Seat, Ward } from '@kindoo/shared';

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

import { NewRequestForm } from '../components/NewRequestForm';

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
      building_id: 'cordera',
      building_name: 'Cordera Building',
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
      building_id: 'genoa',
      building_name: 'Genoa Building',
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

beforeEach(() => {
  vi.clearAllMocks();
  useSeatForMemberMock.mockReturnValue(liveSeatResult(undefined));
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
        wards={wards([{ code: 'CO', building_name: 'Cordera Building' }])}
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
        wards={wards([{ code: 'CO', building_name: 'Cordera Building' }])}
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
        wards={wards([{ code: 'CO', building_name: 'Cordera Building' }])}
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
        wards={wards([{ code: 'CO', building_name: 'Cordera Building' }])}
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

  it('shows the buildings widget for stake scope and requires ≥1 ticked', async () => {
    const user = userEvent.setup();
    render(
      <NewRequestForm
        scopes={[{ value: 'stake', label: 'Stake' }]}
        buildings={buildings()}
        wards={[]}
      />,
    );
    expect(screen.getByTestId('new-request-buildings')).toBeInTheDocument();
    // Stake-scope defaults every building checked (B-11). Untick all
    // to exercise the schema's "≥1 building" gate.
    await user.click(screen.getByTestId('new-request-building-cordera'));
    await user.click(screen.getByTestId('new-request-building-genoa'));
    await user.type(screen.getByTestId('new-request-email'), 'bob@example.com');
    await user.type(screen.getByTestId('new-request-name'), 'Bob');
    await user.type(screen.getByTestId('new-request-reason'), 'visit');
    await user.click(screen.getByTestId('new-request-submit'));
    expect(
      await screen.findByText(/pick at least one building for a stake-scope request/i),
    ).toBeInTheDocument();
    expect(submitMock).not.toHaveBeenCalled();
  });

  it('default-selects the ward building for a single-ward bishopric submitter', async () => {
    const user = userEvent.setup();
    render(
      <NewRequestForm
        scopes={[{ value: 'CO', label: 'Ward CO' }]}
        buildings={buildings()}
        wards={wards([{ code: 'CO', building_name: 'Cordera Building' }])}
      />,
    );
    await user.type(screen.getByTestId('new-request-email'), 'bob@example.com');
    await user.type(screen.getByTestId('new-request-name'), 'Bob');
    await user.type(screen.getByTestId('new-request-reason'), 'visit');
    await user.click(screen.getByTestId('new-request-submit'));
    expect(submitMock).toHaveBeenCalledTimes(1);
    expect(submitMock.mock.calls[0]?.[0]).toMatchObject({
      scope: 'CO',
      building_names: ['Cordera Building'],
    });
  });

  it('submits with empty building_names when the ward has no building_name', async () => {
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
    await user.click(screen.getByTestId('new-request-submit'));
    expect(submitMock).toHaveBeenCalledTimes(1);
    expect(submitMock.mock.calls[0]?.[0]).toMatchObject({
      scope: 'CO',
      building_names: [],
    });
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
    // Stake-scope defaults every building checked (B-11). Untick Genoa
    // so the manager-narrows-the-grant path is what we lock here.
    await user.click(screen.getByTestId('new-request-building-genoa'));
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
      building_names: ['Cordera Building'],
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
      'Buildings: Cordera Building, Genoa Building',
    );
    // Both checkboxes visible (panel is expanded) and pre-checked.
    expect(screen.getByTestId('new-request-building-cordera')).toBeChecked();
    expect(screen.getByTestId('new-request-building-genoa')).toBeChecked();
  });

  it('renders collapsed with the ward building summary for a single-ward bishopric submitter', () => {
    render(
      <NewRequestForm
        scopes={[{ value: 'CO', label: 'Ward CO' }]}
        buildings={buildings()}
        wards={wards([{ code: 'CO', building_name: 'Cordera Building' }])}
      />,
    );
    const trigger = screen.getByTestId('new-request-buildings-trigger');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByTestId('new-request-buildings-summary')).toHaveTextContent(
      'Building: Cordera Building',
    );
  });

  it('shows the leading ward building by default for a multi-ward bishopric submitter, and the dropdown swap updates the header', async () => {
    const user = userEvent.setup();
    render(
      <NewRequestForm
        scopes={[
          { value: 'CO', label: 'Ward CO' },
          { value: 'GE', label: 'Ward GE' },
        ]}
        buildings={buildings()}
        wards={wards([
          { code: 'CO', building_name: 'Cordera Building' },
          { code: 'GE', building_name: 'Genoa Building' },
        ])}
      />,
    );
    const trigger = screen.getByTestId('new-request-buildings-trigger');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    // First scope is CO → its building is the default.
    expect(screen.getByTestId('new-request-buildings-summary')).toHaveTextContent(
      'Building: Cordera Building',
    );
    // Switch to ward GE → header now shows GE's building, still collapsed.
    await user.selectOptions(screen.getByTestId('new-request-scope'), 'GE');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByTestId('new-request-buildings-summary')).toHaveTextContent(
      'Building: Genoa Building',
    );
  });

  it('expands when the trigger is clicked and reveals the full checkbox list with the ward building pre-checked', async () => {
    const user = userEvent.setup();
    render(
      <NewRequestForm
        scopes={[{ value: 'CO', label: 'Ward CO' }]}
        buildings={buildings()}
        wards={wards([{ code: 'CO', building_name: 'Cordera Building' }])}
      />,
    );
    const trigger = screen.getByTestId('new-request-buildings-trigger');
    await user.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    // Ward building pre-checked; the other building unchecked but available.
    expect(screen.getByTestId('new-request-building-cordera')).toBeChecked();
    expect(screen.getByTestId('new-request-building-genoa')).not.toBeChecked();
  });

  it('preserves selection state across collapse / expand toggles', async () => {
    const user = userEvent.setup();
    render(
      <NewRequestForm
        scopes={[{ value: 'CO', label: 'Ward CO' }]}
        buildings={buildings()}
        wards={wards([{ code: 'CO', building_name: 'Cordera Building' }])}
      />,
    );
    const trigger = screen.getByTestId('new-request-buildings-trigger');
    // Expand → tick Genoa as an additional building.
    await user.click(trigger);
    await user.click(screen.getByTestId('new-request-building-genoa'));
    expect(screen.getByTestId('new-request-buildings-summary')).toHaveTextContent(
      'Buildings: Cordera Building, Genoa Building',
    );
    // Collapse → header still lists both.
    await user.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByTestId('new-request-buildings-summary')).toHaveTextContent(
      'Buildings: Cordera Building, Genoa Building',
    );
    // Re-expand → both still ticked.
    await user.click(trigger);
    expect(screen.getByTestId('new-request-building-cordera')).toBeChecked();
    expect(screen.getByTestId('new-request-building-genoa')).toBeChecked();
  });

  it('lets a ward submitter add a second building beyond their ward (the new multi-select capability) when the cross-ward justification comment is filled', async () => {
    // Adding Genoa to a CO request is a cross-ward selection, which
    // gates submit on a non-empty comment (the cross-ward justification
    // rule). With the comment present the submit goes through and
    // carries both building_names.
    const user = userEvent.setup();
    render(
      <NewRequestForm
        scopes={[{ value: 'CO', label: 'Ward CO' }]}
        buildings={buildings()}
        wards={wards([{ code: 'CO', building_name: 'Cordera Building' }])}
      />,
    );
    await user.click(screen.getByTestId('new-request-buildings-trigger'));
    await user.click(screen.getByTestId('new-request-building-genoa'));
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
      building_names: ['Cordera Building', 'Genoa Building'],
    });
  });

  it('lets a ward submitter deselect their default ward building', async () => {
    const user = userEvent.setup();
    render(
      <NewRequestForm
        scopes={[{ value: 'CO', label: 'Ward CO' }]}
        buildings={buildings()}
        wards={wards([{ code: 'CO', building_name: 'Cordera Building' }])}
      />,
    );
    await user.click(screen.getByTestId('new-request-buildings-trigger'));
    // Untick the pre-selected ward building.
    await user.click(screen.getByTestId('new-request-building-cordera'));
    expect(screen.getByTestId('new-request-building-cordera')).not.toBeChecked();
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

describe('<NewRequestForm /> — scope-driven defaults', () => {
  // The buildings widget is derived from the *current scope*, not from
  // role-at-mount. A stake+ward principal toggling the scope dropdown
  // must live-update both the open state and the default selection.
  // Manual collapse/expand and manual selection edits since the last
  // scope change reset on the next scope flip — otherwise a stake-scope
  // expansion bleeds into the new ward-scope view and confuses the user.

  function multiScopePrincipal() {
    return [
      { value: 'stake', label: 'Stake' },
      { value: 'CO', label: 'Ward CO' },
    ];
  }

  it('defaults to only the selected ward building, not the union of every ward the principal holds', async () => {
    // Principal holds CO + GE, in different buildings. Selecting scope
    // CO must pre-check ONLY Cordera. Selecting GE must swap to ONLY
    // Genoa. The principal's other ward access never bleeds into the
    // selection — defaults are a function of the current scope, not
    // the principal's union of wards.
    const user = userEvent.setup();
    render(
      <NewRequestForm
        scopes={[
          { value: 'CO', label: 'Ward CO' },
          { value: 'GE', label: 'Ward GE' },
        ]}
        buildings={buildings()}
        wards={wards([
          { code: 'CO', building_name: 'Cordera Building' },
          { code: 'GE', building_name: 'Genoa Building' },
        ])}
      />,
    );
    // Initial scope = CO → only Cordera ticked.
    await user.click(screen.getByTestId('new-request-buildings-trigger'));
    expect(screen.getByTestId('new-request-building-cordera')).toBeChecked();
    expect(screen.getByTestId('new-request-building-genoa')).not.toBeChecked();

    // Flip to GE → only Genoa ticked, Cordera dropped.
    await user.selectOptions(screen.getByTestId('new-request-scope'), 'GE');
    // The widget collapses on scope change; expand to inspect.
    await user.click(screen.getByTestId('new-request-buildings-trigger'));
    expect(screen.getByTestId('new-request-building-cordera')).not.toBeChecked();
    expect(screen.getByTestId('new-request-building-genoa')).toBeChecked();
  });

  it('flips from expanded+all-checked to collapsed+ward-default when the scope dropdown moves stake → ward', async () => {
    const user = userEvent.setup();
    render(
      <NewRequestForm
        scopes={multiScopePrincipal()}
        buildings={buildings()}
        wards={wards([{ code: 'CO', building_name: 'Cordera Building' }])}
      />,
    );
    const trigger = screen.getByTestId('new-request-buildings-trigger');
    // Initial: stake-scope is the first option → expanded, every building checked (B-11).
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('new-request-buildings-summary')).toHaveTextContent(
      'Buildings: Cordera Building, Genoa Building',
    );

    await user.selectOptions(screen.getByTestId('new-request-scope'), 'CO');

    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByTestId('new-request-buildings-summary')).toHaveTextContent(
      'Building: Cordera Building',
    );
  });

  it('flips from collapsed+ward-default to expanded+all-checked when the scope dropdown moves ward → stake', async () => {
    const user = userEvent.setup();
    // Render the form with the ward as the leading option so it lands
    // collapsed-with-ward-default first, then verify the dropdown flip.
    render(
      <NewRequestForm
        scopes={[
          { value: 'CO', label: 'Ward CO' },
          { value: 'stake', label: 'Stake' },
        ]}
        buildings={buildings()}
        wards={wards([{ code: 'CO', building_name: 'Cordera Building' }])}
      />,
    );
    const trigger = screen.getByTestId('new-request-buildings-trigger');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByTestId('new-request-buildings-summary')).toHaveTextContent(
      'Building: Cordera Building',
    );

    await user.selectOptions(screen.getByTestId('new-request-scope'), 'stake');

    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    // B-11 — stake-scope defaults to every building checked.
    expect(screen.getByTestId('new-request-buildings-summary')).toHaveTextContent(
      'Buildings: Cordera Building, Genoa Building',
    );
    expect(screen.getByTestId('new-request-building-cordera')).toBeChecked();
    expect(screen.getByTestId('new-request-building-genoa')).toBeChecked();
  });

  it('resets a manual stake-scope edit when the user flips to a ward', async () => {
    const user = userEvent.setup();
    render(
      <NewRequestForm
        scopes={[
          { value: 'CO', label: 'Ward CO' },
          { value: 'stake', label: 'Stake' },
        ]}
        buildings={buildings()}
        wards={wards([{ code: 'CO', building_name: 'Cordera Building' }])}
      />,
    );
    const trigger = screen.getByTestId('new-request-buildings-trigger');
    // Switch to stake → expanded, every building checked (B-11). Untick
    // Genoa to simulate the manager-narrows-the-grant edit.
    await user.selectOptions(screen.getByTestId('new-request-scope'), 'stake');
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await user.click(screen.getByTestId('new-request-building-genoa'));
    expect(screen.getByTestId('new-request-building-genoa')).not.toBeChecked();
    expect(screen.getByTestId('new-request-building-cordera')).toBeChecked();

    // Flip back to ward CO → collapses, defaults to ward building, stake-scope edits dropped.
    await user.selectOptions(screen.getByTestId('new-request-scope'), 'CO');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByTestId('new-request-buildings-summary')).toHaveTextContent(
      'Building: Cordera Building',
    );
    // Expand and verify only the ward default survived; the stake-scope
    // untick did not bleed into the ward view.
    await user.click(trigger);
    expect(screen.getByTestId('new-request-building-cordera')).toBeChecked();
    expect(screen.getByTestId('new-request-building-genoa')).not.toBeChecked();
  });

  it('resets a manual ward-scope deselection when the user flips to stake and back', async () => {
    const user = userEvent.setup();
    render(
      <NewRequestForm
        scopes={[
          { value: 'CO', label: 'Ward CO' },
          { value: 'stake', label: 'Stake' },
        ]}
        buildings={buildings()}
        wards={wards([{ code: 'CO', building_name: 'Cordera Building' }])}
      />,
    );
    const trigger = screen.getByTestId('new-request-buildings-trigger');
    // Expand and untick the default ward building.
    await user.click(trigger);
    await user.click(screen.getByTestId('new-request-building-cordera'));
    expect(screen.getByTestId('new-request-building-cordera')).not.toBeChecked();

    // Flip to stake → expanded, every building checked (B-11). Then
    // back to ward → ward default re-applied fresh.
    await user.selectOptions(screen.getByTestId('new-request-scope'), 'stake');
    await user.selectOptions(screen.getByTestId('new-request-scope'), 'CO');
    expect(screen.getByTestId('new-request-buildings-summary')).toHaveTextContent(
      'Building: Cordera Building',
    );
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
      building_names: ['Cordera Building', 'Genoa Building'],
    });
  });

  it('auto-populates building_names to the full catalogue when scope flips ward → stake', async () => {
    const user = userEvent.setup();
    render(
      <NewRequestForm
        scopes={[
          { value: 'CO', label: 'Ward CO' },
          { value: 'stake', label: 'Stake' },
        ]}
        buildings={buildings()}
        wards={wards([{ code: 'CO', building_name: 'Cordera Building' }])}
      />,
    );
    // Initial: ward CO → only Cordera ticked.
    await user.click(screen.getByTestId('new-request-buildings-trigger'));
    expect(screen.getByTestId('new-request-building-cordera')).toBeChecked();
    expect(screen.getByTestId('new-request-building-genoa')).not.toBeChecked();

    // Flip to stake → every building auto-populated.
    await user.selectOptions(screen.getByTestId('new-request-scope'), 'stake');
    expect(screen.getByTestId('new-request-building-cordera')).toBeChecked();
    expect(screen.getByTestId('new-request-building-genoa')).toBeChecked();
    expect(screen.getByTestId('new-request-buildings-summary')).toHaveTextContent(
      'Buildings: Cordera Building, Genoa Building',
    );
  });
});

describe('<NewRequestForm /> — urgent flag', () => {
  it('renders the Urgent? checkbox above the submit button', () => {
    render(
      <NewRequestForm
        scopes={[{ value: 'CO', label: 'Ward CO' }]}
        buildings={buildings()}
        wards={wards([{ code: 'CO', building_name: 'Cordera Building' }])}
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
        wards={wards([{ code: 'CO', building_name: 'Cordera Building' }])}
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
        wards={wards([{ code: 'CO', building_name: 'Cordera Building' }])}
      />,
    );
    await user.type(screen.getByTestId('new-request-email'), 'bob@example.com');
    await user.type(screen.getByTestId('new-request-name'), 'Bob');
    await user.type(screen.getByTestId('new-request-reason'), 'visit');
    await user.click(screen.getByTestId('new-request-urgent'));
    await user.click(screen.getByTestId('new-request-submit'));
    // Inline form error suppressed; the right-aligned helper under the
    // Urgent? checkbox already conveys "comment required". Submit is
    // still gated by the schema; assert only the observable.
    expect(submitMock).not.toHaveBeenCalled();
  });

  it('passes urgent=true through to the submit mutation', async () => {
    const user = userEvent.setup();
    render(
      <NewRequestForm
        scopes={[{ value: 'CO', label: 'Ward CO' }]}
        buildings={buildings()}
        wards={wards([{ code: 'CO', building_name: 'Cordera Building' }])}
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
        wards={wards([{ code: 'CO', building_name: 'Cordera Building' }])}
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
        wards={wards([{ code: 'CO', building_name: 'Cordera Building' }])}
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
        wards={wards([{ code: 'CO', building_name: 'Cordera Building' }])}
      />,
    );
    await user.click(screen.getByTestId('new-request-buildings-trigger'));
    await user.click(screen.getByTestId('new-request-building-genoa'));
    expect(screen.getByTestId('new-request-comment-marker')).toHaveTextContent(/required/i);
  });

  it('flips the marker back to "(optional)" when the user unticks the cross-ward building', async () => {
    const user = userEvent.setup();
    render(
      <NewRequestForm
        scopes={[{ value: 'CO', label: 'Ward CO' }]}
        buildings={buildings()}
        wards={wards([{ code: 'CO', building_name: 'Cordera Building' }])}
      />,
    );
    await user.click(screen.getByTestId('new-request-buildings-trigger'));
    await user.click(screen.getByTestId('new-request-building-genoa'));
    expect(screen.getByTestId('new-request-comment-marker')).toHaveTextContent(/required/i);
    await user.click(screen.getByTestId('new-request-building-genoa'));
    expect(screen.getByTestId('new-request-comment-marker')).toHaveTextContent(/optional/i);
  });

  it('blocks submit with an inline error when a cross-ward selection is missing the comment', async () => {
    const user = userEvent.setup();
    render(
      <NewRequestForm
        scopes={[{ value: 'CO', label: 'Ward CO' }]}
        buildings={buildings()}
        wards={wards([{ code: 'CO', building_name: 'Cordera Building' }])}
      />,
    );
    await user.click(screen.getByTestId('new-request-buildings-trigger'));
    await user.click(screen.getByTestId('new-request-building-genoa'));
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
        wards={wards([{ code: 'CO', building_name: 'Cordera Building' }])}
      />,
    );
    await user.click(screen.getByTestId('new-request-buildings-trigger'));
    await user.click(screen.getByTestId('new-request-building-genoa'));
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
    await user.click(screen.getByTestId('new-request-building-genoa'));
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
        wards={wards([{ code: 'CO', building_name: 'Cordera Building' }])}
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
        wards={wards([{ code: 'CO', building_name: 'Cordera Building' }])}
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

  it('swaps suggestion list on scope change without clearing the typed value', async () => {
    const user = userEvent.setup();
    render(
      <NewRequestForm
        scopes={[
          { value: 'stake', label: 'Stake' },
          { value: 'CO', label: 'Ward CO' },
        ]}
        buildings={buildings()}
        wards={wards([{ code: 'CO', building_name: 'Cordera Building' }])}
      />,
    );
    const reason = screen.getByTestId('new-request-reason') as HTMLInputElement;
    // Stake scope: stake list visible.
    await user.click(reason);
    expect(await screen.findByText('Stake President')).toBeInTheDocument();
    expect(screen.queryByText('Bishop')).toBeNull();

    // Stash a free-text value the user typed.
    await user.type(reason, 'hand-typed reason');
    expect(reason.value).toBe('hand-typed reason');

    // Switch to ward scope. Typed value survives the scope flip.
    await user.selectOptions(screen.getByTestId('new-request-scope'), 'CO');
    expect(reason.value).toBe('hand-typed reason');

    // Re-focus the combobox and clear the filter so the ward list shows.
    await user.click(reason);
    await user.clear(reason);
    expect(await screen.findByText('Bishop')).toBeInTheDocument();
    expect(screen.queryByText('Stake President')).toBeNull();
  });

  it('filters suggestions as the user types', async () => {
    const user = userEvent.setup();
    render(
      <NewRequestForm
        scopes={[{ value: 'CO', label: 'Ward CO' }]}
        buildings={buildings()}
        wards={wards([{ code: 'CO', building_name: 'Cordera Building' }])}
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
        wards={wards([{ code: 'CO', building_name: 'Cordera Building' }])}
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
        wards={wards([{ code: 'CO', building_name: 'Cordera Building' }])}
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
        wards={wards([{ code: 'CO', building_name: 'Cordera Building' }])}
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
        wards={wards([{ code: 'CO', building_name: 'Cordera Building' }])}
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
        wards={wards([{ code: 'CO', building_name: 'Cordera Building' }])}
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

  it('scope change does not affect the plain input when type is add_temp', async () => {
    const user = userEvent.setup();
    render(
      <NewRequestForm
        scopes={[
          { value: 'stake', label: 'Stake' },
          { value: 'CO', label: 'Ward CO' },
        ]}
        buildings={buildings()}
        wards={wards([{ code: 'CO', building_name: 'Cordera Building' }])}
      />,
    );
    await user.selectOptions(screen.getByTestId('new-request-type'), 'add_temp');
    const reason = screen.getByTestId('new-request-reason') as HTMLInputElement;
    await user.type(reason, 'visiting speaker');
    expect(reason.value).toBe('visiting speaker');

    // Flip scope — no suggestion list, value unchanged.
    await user.selectOptions(screen.getByTestId('new-request-scope'), 'CO');
    expect((screen.getByTestId('new-request-reason') as HTMLInputElement).value).toBe(
      'visiting speaker',
    );
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(screen.queryByText('Bishop')).toBeNull();
  });
});

describe('<NewRequestForm /> — duplicate warning', () => {
  it('renders the warning when the live seat hook returns a hit in the same scope', async () => {
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
    expect(await screen.findByTestId('new-request-duplicate-warning')).toBeInTheDocument();
  });

  it('does not warn when the seat is in a different scope', async () => {
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
    expect(screen.queryByTestId('new-request-duplicate-warning')).toBeNull();
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
          { id: 'cordera', name: 'Cordera Building', kindoo_site_id: null },
          { id: 'foothills', name: 'Foothills Building', kindoo_site_id: 'foreign-1' },
        ])}
        wards={[]}
      />,
    );
    // The foreign building's checkbox is absent from the rendered list.
    expect(screen.getByTestId('new-request-building-cordera')).toBeInTheDocument();
    expect(screen.queryByTestId('new-request-building-foothills')).toBeNull();
    // Header summary reflects only the home building.
    expect(screen.getByTestId('new-request-buildings-summary')).toHaveTextContent(
      'Building: Cordera Building',
    );
  });

  it('treats legacy buildings without kindoo_site_id as home (stake scope sees them)', () => {
    render(
      <NewRequestForm
        scopes={[{ value: 'stake', label: 'Stake' }]}
        // No kindoo_site_id field — legacy data; should land as home.
        buildings={buildingsWithSites([
          { id: 'cordera', name: 'Cordera Building' },
          { id: 'foothills', name: 'Foothills Building', kindoo_site_id: 'foreign-1' },
        ])}
        wards={[]}
      />,
    );
    expect(screen.getByTestId('new-request-building-cordera')).toBeInTheDocument();
    expect(screen.queryByTestId('new-request-building-foothills')).toBeNull();
  });

  it('filters a foreign-ward-scope checklist to the matching foreign-site buildings only', async () => {
    // Ward FN lives on foreign site `foreign-1`. The checklist shows
    // foreign-1 buildings only; the home building Cordera is hidden.
    const user = userEvent.setup();
    render(
      <NewRequestForm
        scopes={[{ value: 'FN', label: 'Ward FN' }]}
        buildings={buildingsWithSites([
          { id: 'cordera', name: 'Cordera Building', kindoo_site_id: null },
          { id: 'foothills', name: 'Foothills Building', kindoo_site_id: 'foreign-1' },
        ])}
        wards={wards([
          { code: 'FN', building_name: 'Foothills Building', kindoo_site_id: 'foreign-1' },
        ])}
      />,
    );
    await user.click(screen.getByTestId('new-request-buildings-trigger'));
    expect(screen.getByTestId('new-request-building-foothills')).toBeInTheDocument();
    expect(screen.queryByTestId('new-request-building-cordera')).toBeNull();
    // Ward's home building pre-checked.
    expect(screen.getByTestId('new-request-building-foothills')).toBeChecked();
  });

  it('renders an empty-state message when the site filter narrows the catalogue to zero', () => {
    // Ward FN lives on `foreign-1` but no foreign-1 building is yet
    // configured. The collapsible expands manually so the empty-state
    // is observable. Stake users get a similar message if no home
    // buildings exist.
    render(
      <NewRequestForm
        scopes={[{ value: 'FN', label: 'Ward FN' }]}
        // Only a home building exists; nothing tagged foreign-1.
        buildings={buildingsWithSites([
          { id: 'cordera', name: 'Cordera Building', kindoo_site_id: null },
        ])}
        wards={wards([{ code: 'FN', building_name: '', kindoo_site_id: 'foreign-1' }])}
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

  it('switches the visible building set when the scope dropdown moves between home and foreign wards', async () => {
    const user = userEvent.setup();
    render(
      <NewRequestForm
        scopes={[
          { value: 'CO', label: 'Ward CO' },
          { value: 'FN', label: 'Ward FN' },
        ]}
        buildings={buildingsWithSites([
          { id: 'cordera', name: 'Cordera Building', kindoo_site_id: null },
          { id: 'foothills', name: 'Foothills Building', kindoo_site_id: 'foreign-1' },
        ])}
        wards={wards([
          { code: 'CO', building_name: 'Cordera Building', kindoo_site_id: null },
          { code: 'FN', building_name: 'Foothills Building', kindoo_site_id: 'foreign-1' },
        ])}
      />,
    );
    // Initial scope CO (home) → Cordera visible, Foothills hidden.
    await user.click(screen.getByTestId('new-request-buildings-trigger'));
    expect(screen.getByTestId('new-request-building-cordera')).toBeInTheDocument();
    expect(screen.queryByTestId('new-request-building-foothills')).toBeNull();
    // Flip to FN (foreign) → Foothills visible, Cordera hidden.
    await user.selectOptions(screen.getByTestId('new-request-scope'), 'FN');
    await user.click(screen.getByTestId('new-request-buildings-trigger'));
    expect(screen.getByTestId('new-request-building-foothills')).toBeInTheDocument();
    expect(screen.queryByTestId('new-request-building-cordera')).toBeNull();
  });
});
