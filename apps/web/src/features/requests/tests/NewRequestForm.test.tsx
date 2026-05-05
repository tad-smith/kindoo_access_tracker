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
//     - scope == 'stake' → panel expanded, no defaults checked.
//     - scope == <ward>  → panel collapsed, that ward's building
//       pre-checked and shown in the header summary.
//     - selection state survives expand/collapse toggles within the
//       same scope; the next scope flip resets both the selection and
//       the open state to the new scope's derivation.
//   - Ward users can expand and check additional buildings (multi-
//     select capability the legacy form did not offer).
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

function wards(opts: { code: string; building_name: string }[] = []): Ward[] {
  const stamp = { seconds: 0, nanoseconds: 0, toDate: () => new Date(), toMillis: () => 0 };
  return opts.map(
    ({ code, building_name }) =>
      ({
        ward_code: code,
        ward_name: `Ward ${code}`,
        building_name,
        seat_cap: 20,
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
    await user.click(screen.getByTestId('new-request-building-cordera'));
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
  it('renders expanded with no defaults for a stake-only submitter', () => {
    render(
      <NewRequestForm
        scopes={[{ value: 'stake', label: 'Stake' }]}
        buildings={buildings()}
        wards={[]}
      />,
    );
    const trigger = screen.getByTestId('new-request-buildings-trigger');
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    // Header summary reflects the empty-defaults state.
    expect(screen.getByTestId('new-request-buildings-summary')).toHaveTextContent(/none selected/i);
    // Both checkboxes visible (panel is expanded) and unchecked.
    expect(screen.getByTestId('new-request-building-cordera')).not.toBeChecked();
    expect(screen.getByTestId('new-request-building-genoa')).not.toBeChecked();
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

  it('lets a ward submitter add a second building beyond their ward (the new multi-select capability)', async () => {
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

  it('flips from expanded+empty to collapsed+ward-default when the scope dropdown moves stake → ward', async () => {
    const user = userEvent.setup();
    render(
      <NewRequestForm
        scopes={multiScopePrincipal()}
        buildings={buildings()}
        wards={wards([{ code: 'CO', building_name: 'Cordera Building' }])}
      />,
    );
    const trigger = screen.getByTestId('new-request-buildings-trigger');
    // Initial: stake-scope is the first option → expanded, no defaults.
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('new-request-buildings-summary')).toHaveTextContent(/none selected/i);

    await user.selectOptions(screen.getByTestId('new-request-scope'), 'CO');

    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByTestId('new-request-buildings-summary')).toHaveTextContent(
      'Building: Cordera Building',
    );
  });

  it('flips from collapsed+ward-default to expanded+empty when the scope dropdown moves ward → stake', async () => {
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
    expect(screen.getByTestId('new-request-buildings-summary')).toHaveTextContent(/none selected/i);
    // Both checkboxes unticked (default for stake is empty).
    expect(screen.getByTestId('new-request-building-cordera')).not.toBeChecked();
    expect(screen.getByTestId('new-request-building-genoa')).not.toBeChecked();
  });

  it('resets a manual stake-scope expansion when the user flips to a ward', async () => {
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
    // Switch to stake → expanded. Tick one building.
    await user.selectOptions(screen.getByTestId('new-request-scope'), 'stake');
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await user.click(screen.getByTestId('new-request-building-genoa'));
    expect(screen.getByTestId('new-request-building-genoa')).toBeChecked();

    // Flip back to ward CO → collapses, defaults to ward building, stake-scope edits dropped.
    await user.selectOptions(screen.getByTestId('new-request-scope'), 'CO');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByTestId('new-request-buildings-summary')).toHaveTextContent(
      'Building: Cordera Building',
    );
    // Expand and verify the Genoa tick from the previous scope did not survive.
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

    // Flip to stake → expanded, empty defaults. Then back to ward → ward default re-applied fresh.
    await user.selectOptions(screen.getByTestId('new-request-scope'), 'stake');
    await user.selectOptions(screen.getByTestId('new-request-scope'), 'CO');
    expect(screen.getByTestId('new-request-buildings-summary')).toHaveTextContent(
      'Building: Cordera Building',
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
