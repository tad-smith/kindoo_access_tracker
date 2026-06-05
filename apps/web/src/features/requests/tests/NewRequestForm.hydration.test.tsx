// Hydration-ordering regression for the New Request building checklist
// (production bug — bishopric over a FOREIGN-site ward sees HOME-site
// buildings).
//
// The page (`NewRequestPage`) gates render on `buildings` ONLY, not on
// `wards`. So the form can MOUNT with `buildings` already hydrated while
// `wards` is still `[]` (the live `wards` subscription lands a beat
// later). With `wards = []`:
//   - `siteIdForScope('MR', [], buildings)` → ward not found → null (home)
//   - the checklist shows the HOME-site buildings.
// Once `wards = [MR]` lands, the live `visibleBuildings` memo + the
// scope-driven selection effect must RECOVER the list to the ward's
// foreign-site building. These tests model that exact re-render and
// assert the checklist at each step.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Building, Ward } from '@kindoo/shared';

const submitMock = vi.fn().mockResolvedValue({ id: 'req-stub' });
const useSeatForMemberMock = vi.fn();

vi.mock('../hooks', () => ({
  useSubmitRequest: () => ({ mutateAsync: submitMock, isPending: false }),
  useSeatForMember: (canonical: string | null) => useSeatForMemberMock(canonical),
}));

vi.mock('../../../lib/store/toast', () => ({
  toast: vi.fn(),
}));

import { NewRequestForm } from '../components/NewRequestForm';

function liveSeatResult(seat: undefined) {
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

const stamp = { seconds: 0, nanoseconds: 0, toDate: () => new Date(), toMillis: () => 0 };

// Exact prod data (verified with operator).
// Ward MR → building_name "Black Forest" (no kindoo_site_id on the ward —
// removed in #192; the site derives from the building).
function wardMR(): Ward {
  return {
    ward_code: 'MR',
    ward_name: 'Meadow Run',
    building_name: 'Black Forest',
    seat_cap: 25,
    created_at: stamp,
    last_modified_at: stamp,
    lastActor: { email: 'a@b.c', canonical: 'a@b.c' },
  } as unknown as Ward;
}

// Black Forest is tagged to the FOREIGN site; two home buildings carry
// `kindoo_site_id: null`.
function prodBuildings(): Building[] {
  const mk = (id: string, name: string, kindoo_site_id: string | null): Building =>
    ({
      building_id: id,
      building_name: name,
      address: '',
      kindoo_site_id,
      created_at: stamp,
      last_modified_at: stamp,
      lastActor: { email: 'a@b.c', canonical: 'a@b.c' },
    }) as unknown as Building;
  return [
    mk('black-forest', 'Black Forest', 'colorado-springs-high-plains-stake'),
    mk('home-chapel', 'Home Chapel', null),
    mk('home-annex', 'Home Annex', null),
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
  useSeatForMemberMock.mockReturnValue(liveSeatResult(undefined));
});

describe('<NewRequestForm /> — wards-hydrate-after-buildings ordering (foreign ward)', () => {
  const scopes = [{ value: 'MR', label: 'Ward MR' }];

  it('recovers the checklist to the foreign-site building once wards hydrates', async () => {
    const user = userEvent.setup();
    const buildings = prodBuildings();

    // Step 1 — buildings present, wards still []. The form mounts with
    // ward MR unknown → site resolves to home → HOME buildings shown.
    const view = render(<NewRequestForm scopes={scopes} buildings={buildings} wards={[]} />);

    await user.click(screen.getByTestId('new-request-buildings-trigger'));

    // Bug-state snapshot: home buildings are visible, Black Forest hidden.
    expect(screen.getByTestId('new-request-building-home-chapel')).toBeInTheDocument();
    expect(screen.getByTestId('new-request-building-home-annex')).toBeInTheDocument();
    expect(screen.queryByTestId('new-request-building-black-forest')).toBeNull();

    // Step 2 — wards live-subscription lands [MR]. Same buildings array
    // identity (the buildings subscription has not changed); only wards
    // flips. The checklist MUST recover to the ward's foreign building.
    view.rerender(<NewRequestForm scopes={scopes} buildings={buildings} wards={[wardMR()]} />);

    // The foreign-site building must now be the only one shown, and the
    // home buildings must be gone.
    expect(screen.getByTestId('new-request-building-black-forest')).toBeInTheDocument();
    expect(screen.queryByTestId('new-request-building-home-chapel')).toBeNull();
    expect(screen.queryByTestId('new-request-building-home-annex')).toBeNull();
    // And it should be pre-checked (the ward default).
    expect(screen.getByTestId('new-request-building-black-forest')).toBeChecked();
  });

  it('recovers without the user opening the panel first (memo/effect path only)', () => {
    const buildings = prodBuildings();

    // Mount collapsed with wards=[] (the realistic flow — the panel is
    // collapsed for ward scope and the user submits without opening it).
    const view = render(<NewRequestForm scopes={scopes} buildings={buildings} wards={[]} />);

    // Header summary in the bug state reflects whatever defaulted. We
    // don't assert it here — the point is the post-hydration state.
    view.rerender(<NewRequestForm scopes={scopes} buildings={buildings} wards={[wardMR()]} />);

    // After hydration the header summary must show ONLY Black Forest.
    expect(screen.getByTestId('new-request-buildings-summary')).toHaveTextContent(
      'Building: Black Forest',
    );
  });

  it('submits only the foreign-site building after wards hydrates (collapsed flow)', async () => {
    const user = userEvent.setup();
    const buildings = prodBuildings();

    const view = render(<NewRequestForm scopes={scopes} buildings={buildings} wards={[]} />);
    view.rerender(<NewRequestForm scopes={scopes} buildings={buildings} wards={[wardMR()]} />);

    await user.type(screen.getByTestId('new-request-email'), 'bob@example.com');
    await user.type(screen.getByTestId('new-request-name'), 'Bob');
    await user.type(screen.getByTestId('new-request-reason'), 'visit');
    await user.click(screen.getByTestId('new-request-submit'));

    expect(submitMock).toHaveBeenCalledTimes(1);
    expect(submitMock.mock.calls[0]?.[0]).toMatchObject({
      scope: 'MR',
      building_names: ['Black Forest'],
    });
  });

  it('recovers even when the buildings array gets a NEW identity on the wards render', () => {
    // Live subscriptions may hand a fresh array on the same snapshot that
    // wards arrives. Model both props changing identity together.
    const view = render(<NewRequestForm scopes={scopes} buildings={prodBuildings()} wards={[]} />);
    view.rerender(
      <NewRequestForm scopes={scopes} buildings={prodBuildings()} wards={[wardMR()]} />,
    );
    expect(screen.getByTestId('new-request-buildings-summary')).toHaveTextContent(
      'Building: Black Forest',
    );
  });

  it('recovers when the user opened the panel BEFORE wards hydrated (dirty-open path)', async () => {
    // The user expands the (home-defaulted) panel while wards is still
    // []. They have NOT touched a checkbox. Then wards lands. The
    // scope-driven effect re-derives the default — but does the user's
    // open state or a stale form value block it?
    const user = userEvent.setup();
    const buildings = prodBuildings();
    const view = render(<NewRequestForm scopes={scopes} buildings={buildings} wards={[]} />);
    await user.click(screen.getByTestId('new-request-buildings-trigger'));
    view.rerender(<NewRequestForm scopes={scopes} buildings={buildings} wards={[wardMR()]} />);
    expect(screen.getByTestId('new-request-building-black-forest')).toBeInTheDocument();
    expect(screen.queryByTestId('new-request-building-home-chapel')).toBeNull();
  });

  it('recovers across a three-step hydration (undefined-ish [] then partial then full)', () => {
    // wards: [] → [unrelated other ward] → [MR]. Tests that a non-empty
    // but MR-less intermediate state does not lock the resolution.
    const buildings = prodBuildings();
    const otherWard = {
      ...wardMR(),
      ward_code: 'XX',
      ward_name: 'Other',
      building_name: 'Home Chapel',
    } as unknown as Ward;
    const view = render(<NewRequestForm scopes={scopes} buildings={buildings} wards={[]} />);
    view.rerender(<NewRequestForm scopes={scopes} buildings={buildings} wards={[otherWard]} />);
    view.rerender(
      <NewRequestForm scopes={scopes} buildings={buildings} wards={[otherWard, wardMR()]} />,
    );
    expect(screen.getByTestId('new-request-buildings-summary')).toHaveTextContent(
      'Building: Black Forest',
    );
  });
});
