// Component tests for the shared NewRequestForm. Mocks the submit
// mutation + duplicate-warning subscription so the test exercises just
// the validation + render shape.
//
// Coverage target:
//   - Member name + reason are required (`add_manual` / `add_temp`).
//   - `add_temp` shows date inputs with both required.
//   - `add_temp` end < start fails validation.
//   - Stake-scope add types require ≥1 building checkbox.
//   - Bishopric scope hides the buildings group.
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
        wards={[]}
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
        wards={[]}
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
        wards={[]}
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
        wards={[]}
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

  it('hides the buildings fieldset for ward (bishopric) scope', () => {
    render(
      <NewRequestForm
        scopes={[{ value: 'CO', label: 'Ward CO' }]}
        buildings={buildings()}
        wards={[]}
      />,
    );
    expect(screen.queryByTestId('new-request-buildings')).toBeNull();
  });

  it('shows the buildings fieldset for stake scope and requires ≥1 ticked', async () => {
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

  it('auto-populates building_names from the ward.building_name on ward-scope', async () => {
    const user = userEvent.setup();
    render(
      <NewRequestForm
        scopes={[{ value: 'CO', label: 'Ward CO' }]}
        buildings={buildings()}
        wards={wards([{ code: 'CO', building_name: 'Cordera Building' }])}
      />,
    );
    // Ward-scope hides the buildings fieldset.
    expect(screen.queryByTestId('new-request-buildings')).toBeNull();
    await user.type(screen.getByTestId('new-request-email'), 'bob@example.com');
    await user.type(screen.getByTestId('new-request-name'), 'Bob');
    await user.type(screen.getByTestId('new-request-reason'), 'visit');
    await user.click(screen.getByTestId('new-request-submit'));
    expect(submitMock).toHaveBeenCalledTimes(1);
    const call = submitMock.mock.calls[0]?.[0];
    expect(call).toMatchObject({
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
