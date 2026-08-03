// Component tests for the Manager Access page.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Access } from '@kindoo/shared';
import { makeAccess } from '../../../../test/fixtures';

const useAccessListMock = vi.fn();
const useStakeWardsMock = vi.fn();
const addManualMutate = vi.fn().mockResolvedValue(undefined);
const deleteManualMutate = vi.fn().mockResolvedValue(undefined);

vi.mock('./hooks', () => ({
  useAccessList: () => useAccessListMock(),
  useAddManualGrantMutation: () => ({ mutateAsync: addManualMutate, isPending: false }),
  useDeleteManualGrantMutation: () => ({ mutateAsync: deleteManualMutate, isPending: false }),
}));

vi.mock('../dashboard/hooks', () => ({
  useStakeWards: () => useStakeWardsMock(),
}));

// AccessPage filters the scope dropdown by the principal's claims.
// Default the test principal to a manager so all wards + 'stake'
// surface; individual tests can override.
vi.mock('../../../lib/principal', () => ({
  usePrincipal: () => ({
    isAuthenticated: true,
    firebaseAuthSignedIn: true,
    email: 'mgr@example.com',
    canonical: 'mgr@example.com',
    isPlatformSuperadmin: false,
    managerStakes: ['csnorth'],
    stakeMemberStakes: [],
    bishopricWards: {},
    hasAnyRole: () => true,
    wardsInStake: () => [],
  }),
}));

import { AccessPage } from './AccessPage';

// The Scope cell now carries the level chip after the scope name; the
// sort assertions care only about the name, which is the cell's first
// child node.
function scopeName(td: Element): string {
  return (td.childNodes[0]?.textContent ?? '').trim();
}

function liveResult<T>(data: T[] | undefined, isLoading = false) {
  return {
    data,
    error: null,
    status: isLoading ? 'pending' : 'success',
    isPending: isLoading,
    isLoading,
    isSuccess: !isLoading,
    isError: false,
    isFetching: false,
    fetchStatus: 'idle',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  useStakeWardsMock.mockReturnValue(liveResult([]));
});

describe('<AccessPage />', () => {
  it('renders the empty-state copy when no access rows exist', () => {
    useAccessListMock.mockReturnValue(liveResult<Access>([]));
    render(<AccessPage />);
    expect(screen.getByText(/no access rows/i)).toBeInTheDocument();
  });

  it('renders one card per user', () => {
    useAccessListMock.mockReturnValue(
      liveResult([
        makeAccess({ member_canonical: 'a@x.com', member_email: 'a@x.com' }),
        makeAccess({ member_canonical: 'b@x.com', member_email: 'b@x.com' }),
      ]),
    );
    render(<AccessPage />);
    expect(screen.getByTestId('access-card-a@x.com')).toBeInTheDocument();
    expect(screen.getByTestId('access-card-b@x.com')).toBeInTheDocument();
  });

  it('renders the card header member via the shared name/email line', () => {
    useAccessListMock.mockReturnValue(
      liveResult([
        makeAccess({
          member_canonical: 'alice@example.com',
          member_email: 'alice@example.com',
          member_name: 'Alice Example',
        }),
      ]),
    );
    render(<AccessPage />);
    // jsdom has no media queries, so assert DOM presence: bold name, the
    // mobile `email:` label, and the email all exist in the header markup.
    const member = screen
      .getByTestId('access-card-alice@example.com')
      .querySelector('.roster-card-member');
    expect(member?.querySelector('.roster-card-name')?.textContent).toBe('Alice Example');
    expect(member?.querySelector('.roster-card-email-label')?.textContent).toBe('email:');
    expect(member?.querySelector('.roster-email')?.textContent).toBe('alice@example.com');
  });

  it('orders cards by sort_order ascending; lower sort_order renders higher', () => {
    // Email order (z, a, m) deliberately does NOT match sort_order
    // order (1, 2, 5) — only the sort_order ordering should win.
    useAccessListMock.mockReturnValue(
      liveResult([
        makeAccess({ member_canonical: 'z@x.com', member_email: 'z@x.com', sort_order: 5 }),
        makeAccess({ member_canonical: 'a@x.com', member_email: 'a@x.com', sort_order: 1 }),
        makeAccess({ member_canonical: 'm@x.com', member_email: 'm@x.com', sort_order: 2 }),
      ]),
    );
    render(<AccessPage />);
    const cards = screen.getByTestId('access-cards');
    const ids = Array.from(cards.querySelectorAll('[data-testid^="access-card-"]')).map((c) =>
      c.getAttribute('data-testid'),
    );
    expect(ids).toEqual(['access-card-a@x.com', 'access-card-m@x.com', 'access-card-z@x.com']);
  });

  it('places rows with null/undefined sort_order at the bottom (tie-broken alpha by email)', () => {
    useAccessListMock.mockReturnValue(
      liveResult([
        makeAccess({
          member_canonical: 'orphan-z@x.com',
          member_email: 'orphan-z@x.com',
          // sort_order omitted → bottom.
        }),
        makeAccess({ member_canonical: 'a@x.com', member_email: 'a@x.com', sort_order: 1 }),
        makeAccess({
          member_canonical: 'orphan-a@x.com',
          member_email: 'orphan-a@x.com',
          // sort_order omitted → bottom; tie-broken alpha vs orphan-z.
        }),
        makeAccess({ member_canonical: 'b@x.com', member_email: 'b@x.com', sort_order: 2 }),
      ]),
    );
    render(<AccessPage />);
    const cards = screen.getByTestId('access-cards');
    const ids = Array.from(cards.querySelectorAll('[data-testid^="access-card-"]')).map((c) =>
      c.getAttribute('data-testid'),
    );
    expect(ids).toEqual([
      'access-card-a@x.com',
      'access-card-b@x.com',
      'access-card-orphan-a@x.com',
      'access-card-orphan-z@x.com',
    ]);
  });

  it('breaks sort_order ties alphabetically by member_email', () => {
    useAccessListMock.mockReturnValue(
      liveResult([
        makeAccess({ member_canonical: 'b@x.com', member_email: 'b@x.com', sort_order: 1 }),
        makeAccess({ member_canonical: 'a@x.com', member_email: 'a@x.com', sort_order: 1 }),
      ]),
    );
    render(<AccessPage />);
    const cards = screen.getByTestId('access-cards');
    const ids = Array.from(cards.querySelectorAll('[data-testid^="access-card-"]')).map((c) =>
      c.getAttribute('data-testid'),
    );
    expect(ids).toEqual(['access-card-a@x.com', 'access-card-b@x.com']);
  });

  it('groups cards by scope band: stake users top, then ward users alpha by ward_code', () => {
    // Even though the GE user has the lowest sort_order, the stake
    // users sit in the top band and the GE user goes to its own band
    // (after CO).
    useAccessListMock.mockReturnValue(
      liveResult([
        makeAccess({
          member_canonical: 'co1@x.com',
          member_email: 'co1@x.com',
          importer_callings: { CO: ['Bishop'] },
          manual_grants: {},
          sort_order: 4,
        }),
        makeAccess({
          member_canonical: 'ge1@x.com',
          member_email: 'ge1@x.com',
          importer_callings: { GE: ['Bishop'] },
          manual_grants: {},
          sort_order: 1,
        }),
        makeAccess({
          member_canonical: 'stake-b@x.com',
          member_email: 'stake-b@x.com',
          importer_callings: { stake: ['Stake Clerk'] },
          manual_grants: {},
          sort_order: 5,
        }),
        makeAccess({
          member_canonical: 'stake-a@x.com',
          member_email: 'stake-a@x.com',
          importer_callings: { stake: ['Stake President'] },
          manual_grants: {},
          sort_order: 2,
        }),
      ]),
    );
    render(<AccessPage />);
    const cards = screen.getByTestId('access-cards');
    const ids = Array.from(cards.querySelectorAll('[data-testid^="access-card-"]')).map((c) =>
      c.getAttribute('data-testid'),
    );
    expect(ids).toEqual([
      'access-card-stake-a@x.com',
      'access-card-stake-b@x.com',
      'access-card-co1@x.com',
      'access-card-ge1@x.com',
    ]);
  });

  it('places manual-only users in the right ward band based on their first manual scope', () => {
    const grant = {
      grant_id: 'g1',
      reason: 'Covering bishop',
      granted_by: { email: 'm@example.com', canonical: 'm@example.com' },
      granted_at: { seconds: 0, nanoseconds: 0, toDate: () => new Date(), toMillis: () => 0 },
    };
    useAccessListMock.mockReturnValue(
      liveResult([
        makeAccess({
          member_canonical: 'manual-co@x.com',
          member_email: 'manual-co@x.com',
          importer_callings: {},
          manual_grants: { CO: [grant] },
          sort_order: 99,
        }),
        makeAccess({
          member_canonical: 'stake-a@x.com',
          member_email: 'stake-a@x.com',
          importer_callings: { stake: ['Stake President'] },
          manual_grants: {},
          sort_order: 2,
        }),
      ]),
    );
    render(<AccessPage />);
    const cards = screen.getByTestId('access-cards');
    const ids = Array.from(cards.querySelectorAll('[data-testid^="access-card-"]')).map((c) =>
      c.getAttribute('data-testid'),
    );
    // Stake band first, then CO band.
    expect(ids).toEqual(['access-card-stake-a@x.com', 'access-card-manual-co@x.com']);
  });

  it('renders only the importer section for an importer-only user', () => {
    useAccessListMock.mockReturnValue(
      liveResult([makeAccess({ importer_callings: { CO: ['Bishop'] }, manual_grants: {} })]),
    );
    render(<AccessPage />);
    expect(screen.getByTestId('access-section-importer')).toBeInTheDocument();
    expect(screen.queryByTestId('access-section-manual')).toBeNull();
  });

  it('renders only the manual section for a manual-only user', () => {
    const grant = {
      grant_id: 'g1',
      reason: 'Covering bishop',
      granted_by: { email: 'm@example.com', canonical: 'm@example.com' },
      granted_at: { seconds: 0, nanoseconds: 0, toDate: () => new Date(), toMillis: () => 0 },
    };
    useAccessListMock.mockReturnValue(
      liveResult([makeAccess({ importer_callings: {}, manual_grants: { stake: [grant] } })]),
    );
    render(<AccessPage />);
    expect(screen.queryByTestId('access-section-importer')).toBeNull();
    expect(screen.getByTestId('access-section-manual')).toBeInTheDocument();
    // "Covering bishop" appears in both the desktop table and the
    // mobile-card view; both are mounted, CSS picks which is visible.
    expect(screen.getAllByText(/covering bishop/i).length).toBeGreaterThan(0);
  });

  it('renders both sections for a split-ownership user', () => {
    const grant = {
      grant_id: 'g1',
      reason: 'Stake exec',
      granted_by: { email: 'm@example.com', canonical: 'm@example.com' },
      granted_at: { seconds: 0, nanoseconds: 0, toDate: () => new Date(), toMillis: () => 0 },
    };
    useAccessListMock.mockReturnValue(
      liveResult([
        makeAccess({
          importer_callings: { CO: ['Bishop'] },
          manual_grants: { stake: [grant] },
        }),
      ]),
    );
    render(<AccessPage />);
    const card = screen.getByTestId('access-card-alice@example.com');
    expect(within(card).getByTestId('access-section-importer')).toBeInTheDocument();
    expect(within(card).getByTestId('access-section-manual')).toBeInTheDocument();
  });

  it('filters by scope', async () => {
    const u = userEvent.setup();
    // Scope dropdown is sourced from the principal's claims + the wards
    // collection. Seed wards so CO + GE surface in the picker.
    useStakeWardsMock.mockReturnValue(
      liveResult([
        { ward_code: 'CO', ward_name: 'Maple' },
        { ward_code: 'GE', ward_name: 'Cedar' },
      ]),
    );
    useAccessListMock.mockReturnValue(
      liveResult([
        makeAccess({
          member_canonical: 'co@x.com',
          member_email: 'co@x.com',
          importer_callings: { CO: ['Bishop'] },
        }),
        makeAccess({
          member_canonical: 'ge@x.com',
          member_email: 'ge@x.com',
          importer_callings: { GE: ['Bishop'] },
        }),
      ]),
    );
    render(<AccessPage />);
    expect(screen.getByTestId('access-card-co@x.com')).toBeInTheDocument();
    expect(screen.getByTestId('access-card-ge@x.com')).toBeInTheDocument();
    await u.selectOptions(screen.getByLabelText(/^Scope:/), 'CO');
    expect(screen.getByTestId('access-card-co@x.com')).toBeInTheDocument();
    expect(screen.queryByTestId('access-card-ge@x.com')).toBeNull();
  });

  it('renders the Add Manual Access button (form is in a modal)', () => {
    useAccessListMock.mockReturnValue(liveResult<Access>([]));
    render(<AccessPage />);
    expect(screen.getByTestId('access-add-manual-button')).toBeInTheDocument();
    expect(screen.queryByTestId('add-manual-form')).toBeNull();
  });

  it('opens the Add Manual Access modal when the button is clicked', async () => {
    const u = userEvent.setup();
    useAccessListMock.mockReturnValue(liveResult<Access>([]));
    render(<AccessPage />);
    await u.click(screen.getByTestId('access-add-manual-button'));
    expect(screen.getByTestId('add-manual-form')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Add Manual Access' })).toBeInTheDocument();
  });

  it('add-modal scope dropdown shows stake + one option per configured ward', async () => {
    const u = userEvent.setup();
    useStakeWardsMock.mockReturnValue(
      liveResult([
        { ward_code: 'GE', ward_name: 'Cedar' },
        { ward_code: 'CO', ward_name: 'Maple' },
      ]),
    );
    useAccessListMock.mockReturnValue(liveResult<Access>([]));
    render(<AccessPage />);
    await u.click(screen.getByTestId('access-add-manual-button'));
    const dropdown = screen.getByTestId('add-manual-scope') as HTMLSelectElement;
    const values = Array.from(dropdown.options).map((o) => o.value);
    // 'stake' first; wards alphabetical.
    expect(values).toEqual(['stake', 'CO', 'GE']);
  });

  it('add-modal scope dropdown shows only stake when no wards are configured', async () => {
    const u = userEvent.setup();
    useStakeWardsMock.mockReturnValue(liveResult([]));
    useAccessListMock.mockReturnValue(liveResult<Access>([]));
    render(<AccessPage />);
    await u.click(screen.getByTestId('access-add-manual-button'));
    const dropdown = screen.getByTestId('add-manual-scope') as HTMLSelectElement;
    const values = Array.from(dropdown.options).map((o) => o.value);
    expect(values).toEqual(['stake']);
    expect(screen.getByTestId('add-manual-no-wards')).toBeInTheDocument();
  });

  it('add-modal scope dropdown is disabled while wards are still loading', async () => {
    const u = userEvent.setup();
    useStakeWardsMock.mockReturnValue(liveResult(undefined, true));
    useAccessListMock.mockReturnValue(liveResult<Access>([]));
    render(<AccessPage />);
    await u.click(screen.getByTestId('access-add-manual-button'));
    const dropdown = screen.getByTestId('add-manual-scope') as HTMLSelectElement;
    expect(dropdown).toBeDisabled();
  });

  it('invokes the add-mutation when the modal form is submitted with valid input', async () => {
    useAccessListMock.mockReturnValue(liveResult<Access>([]));
    const u = userEvent.setup();
    render(<AccessPage />);
    await u.click(screen.getByTestId('access-add-manual-button'));
    const form = screen.getByTestId('add-manual-form');
    await u.type(within(form).getByLabelText(/Email/i), 'sub@example.com');
    await u.type(within(form).getByLabelText(/Name/i), 'Sub');
    await u.type(within(form).getByLabelText(/Reason/i), 'Covering bishop');
    await u.click(screen.getByTestId('access-add-manual-submit'));
    expect(addManualMutate).toHaveBeenCalledWith(
      expect.objectContaining({ member_email: 'sub@example.com', reason: 'Covering bishop' }),
    );
  });

  it('renders a desktop table with the expected column order', () => {
    useAccessListMock.mockReturnValue(
      liveResult([
        makeAccess({
          member_canonical: 'a@x.com',
          member_email: 'a@x.com',
          importer_callings: { CO: ['Bishop'] },
          manual_grants: {
            stake: [
              {
                grant_id: 'g1',
                reason: 'Covering bishop',
                granted_by: { email: 'm@x.com', canonical: 'm@x.com' },
                granted_at: {
                  seconds: 0,
                  nanoseconds: 0,
                  toDate: () => new Date(),
                  toMillis: () => 0,
                },
              },
            ],
          },
        }),
      ]),
    );
    render(<AccessPage />);
    const table = screen.getByTestId('access-table');
    const headers = Array.from(table.querySelectorAll('thead th')).map((th) => th.textContent);
    expect(headers).toEqual(['Scope', 'Calling / reason', 'Email', 'Source', 'Actions']);
    // Two rows: one importer (CO/Bishop) + one manual (stake/Covering bishop).
    expect(table.querySelectorAll('tbody tr')).toHaveLength(2);
  });

  it('table view sorts rows by scope band, then per-row canonical calling order', () => {
    // Per-row order comes from the canonical churchwide table
    // (`callingSortOrder`): Stake President precedes Stake Clerk; Bishop
    // precedes the off-table "EQ President" (which falls to +Infinity).
    useStakeWardsMock.mockReturnValue(
      liveResult([
        { ward_code: 'CO', ward_name: 'Maple' },
        { ward_code: 'GE', ward_name: 'Cedar' },
      ]),
    );
    useAccessListMock.mockReturnValue(
      liveResult([
        // Mixed users — assertions read every flat row.
        makeAccess({
          member_canonical: 'a@x.com',
          member_email: 'a@x.com',
          // Stake Clerk should land BELOW Stake President.
          importer_callings: { stake: ['Stake Clerk'] },
          manual_grants: {},
        }),
        makeAccess({
          member_canonical: 'b@x.com',
          member_email: 'b@x.com',
          importer_callings: { stake: ['Stake President'] },
          manual_grants: {},
        }),
        makeAccess({
          member_canonical: 'c@x.com',
          member_email: 'c@x.com',
          // Off-table calling → +Infinity → bottom of CO band.
          importer_callings: { CO: ['EQ President'] },
          manual_grants: {},
        }),
        makeAccess({
          member_canonical: 'd@x.com',
          member_email: 'd@x.com',
          importer_callings: { CO: ['Bishop'] },
          manual_grants: {},
        }),
        makeAccess({
          member_canonical: 'e@x.com',
          member_email: 'e@x.com',
          importer_callings: { GE: ['Counselor'] },
          manual_grants: {},
        }),
      ]),
    );
    render(<AccessPage />);
    const table = screen.getByTestId('access-table');
    const rows = Array.from(table.querySelectorAll('tbody tr')).map((tr) => {
      const cells = Array.from(tr.querySelectorAll('td'));
      return `${scopeName(cells[0]!)}|${cells[1]?.textContent?.trim() ?? ''}`;
    });
    expect(rows).toEqual([
      'Stake|Stake President', // canonical order 0
      'Stake|Stake Clerk', // canonical order 3
      'Maple|Bishop', // in-table → above the off-table row
      'Maple|EQ President', // off-table → +Infinity → bottom of CO band
      'Cedar|Counselor', // GE band (only row)
    ]);
  });

  it('table view places manual grants at the bottom of their scope band (no calling match)', () => {
    useStakeWardsMock.mockReturnValue(liveResult([{ ward_code: 'CO', ward_name: 'Maple' }]));
    useAccessListMock.mockReturnValue(
      liveResult([
        makeAccess({
          member_canonical: 'm@x.com',
          member_email: 'm@x.com',
          importer_callings: {},
          manual_grants: {
            stake: [
              {
                grant_id: 'g1',
                reason: 'Covering bishop',
                granted_by: { email: 'mgr@x.com', canonical: 'mgr@x.com' },
                granted_at: {
                  seconds: 0,
                  nanoseconds: 0,
                  toDate: () => new Date(),
                  toMillis: () => 0,
                },
              },
            ],
          },
        }),
        makeAccess({
          member_canonical: 'p@x.com',
          member_email: 'p@x.com',
          importer_callings: { stake: ['Stake President'] },
          manual_grants: {},
        }),
      ]),
    );
    render(<AccessPage />);
    const table = screen.getByTestId('access-table');
    const rows = Array.from(table.querySelectorAll('tbody tr')).map((tr) => {
      const cells = Array.from(tr.querySelectorAll('td'));
      return `${scopeName(cells[0]!)}|${cells[1]?.textContent?.trim() ?? ''}`;
    });
    expect(rows).toEqual([
      'Stake|Stake President', // canonical order 0
      'Stake|Covering bishop', // manual → +Infinity → bottom of stake band
    ]);
  });

  it('defaults the add-modal access level to Full', async () => {
    const u = userEvent.setup();
    useAccessListMock.mockReturnValue(liveResult<Access>([]));
    render(<AccessPage />);
    await u.click(screen.getByTestId('access-add-manual-button'));
    const level = screen.getByTestId('add-manual-level') as HTMLSelectElement;
    expect(Array.from(level.options).map((o) => o.value)).toEqual(['full', 'limited']);
    expect(level.value).toBe('full');
  });

  it('submits level "full" when the access level is left at its default', async () => {
    const u = userEvent.setup();
    useAccessListMock.mockReturnValue(liveResult<Access>([]));
    render(<AccessPage />);
    await u.click(screen.getByTestId('access-add-manual-button'));
    const form = screen.getByTestId('add-manual-form');
    await u.type(within(form).getByLabelText(/Email/i), 'sub@example.com');
    await u.type(within(form).getByLabelText(/Name/i), 'Sub');
    await u.type(within(form).getByLabelText(/Reason/i), 'Covering bishop');
    await u.click(screen.getByTestId('access-add-manual-submit'));
    expect(addManualMutate).toHaveBeenCalledWith(expect.objectContaining({ level: 'full' }));
  });

  it('submits level "limited" when Limited is chosen', async () => {
    const u = userEvent.setup();
    useAccessListMock.mockReturnValue(liveResult<Access>([]));
    render(<AccessPage />);
    await u.click(screen.getByTestId('access-add-manual-button'));
    const form = screen.getByTestId('add-manual-form');
    await u.type(within(form).getByLabelText(/Email/i), 'sub@example.com');
    await u.type(within(form).getByLabelText(/Name/i), 'Sub');
    await u.selectOptions(screen.getByTestId('add-manual-level'), 'limited');
    await u.type(within(form).getByLabelText(/Reason/i), 'Covering bishop');
    await u.click(screen.getByTestId('access-add-manual-submit'));
    expect(addManualMutate).toHaveBeenCalledWith(expect.objectContaining({ level: 'limited' }));
  });

  it('renders LIMITED in the Scope cell, not the Calling/reason cell', () => {
    useStakeWardsMock.mockReturnValue(liveResult([{ ward_code: 'CO', ward_name: 'Maple' }]));
    useAccessListMock.mockReturnValue(
      liveResult([
        makeAccess({
          member_canonical: 'lim@x.com',
          member_email: 'lim@x.com',
          importer_callings: {},
          manual_grants: {
            CO: [
              {
                grant_id: 'g-lim',
                reason: 'Covering bishop',
                level: 'limited',
                granted_by: { email: 'm@x.com', canonical: 'm@x.com' },
                granted_at: {
                  seconds: 0,
                  nanoseconds: 0,
                  toDate: () => new Date(),
                  toMillis: () => 0,
                },
              },
            ],
          },
        }),
      ]),
    );
    render(<AccessPage />);
    const cells = Array.from(
      screen.getByTestId('access-table').querySelectorAll('tbody tr td'),
    ) as HTMLElement[];
    const chip = screen.getByTestId('access-table-level-lim@x.com-g-lim');
    expect(chip).toHaveTextContent('LIMITED');
    expect(cells[0]).toContainElement(chip);
    // Scope name still leads the cell; the chip trails it.
    expect(scopeName(cells[0]!)).toBe('Maple');
    // Calling/reason cell is now the bare reason — no chip.
    expect(cells[1]).toHaveTextContent('Covering bishop');
    expect(cells[1]!.querySelector('[data-testid^="access-table-level-"]')).toBeNull();
  });

  // Inverted from the pre-D25-chip behaviour, which asserted a full grant
  // rendered NOTHING. A silent cell was indistinguishable from a render
  // bug or a stale bundle, so full grants now say so explicitly.
  it('renders Full in the Scope cell for a manual grant carrying no level key', () => {
    useAccessListMock.mockReturnValue(
      liveResult([
        makeAccess({
          member_canonical: 'full@x.com',
          member_email: 'full@x.com',
          importer_callings: {},
          manual_grants: {
            stake: [
              {
                grant_id: 'g-full',
                reason: 'Covering bishop',
                granted_by: { email: 'm@x.com', canonical: 'm@x.com' },
                granted_at: {
                  seconds: 0,
                  nanoseconds: 0,
                  toDate: () => new Date(),
                  toMillis: () => 0,
                },
              },
            ],
          },
        }),
      ]),
    );
    render(<AccessPage />);
    const chip = screen.getByTestId('access-table-level-full@x.com-g-full');
    expect(chip).toHaveTextContent('Full');
    const cells = Array.from(screen.getByTestId('access-table').querySelectorAll('tbody tr td'));
    expect(cells[0]).toContainElement(chip);
    expect(screen.getByTestId('access-grant-level-full@x.com-g-full')).toHaveTextContent('Full');
  });

  // THE no-migration regression. `importer_limited_callings` is absent on
  // every access doc written before the stamp shipped — the overwhelmingly
  // common case — and those docs must render exactly as they did. The
  // calling deliberately carries the name that DOES confer limited access
  // once stamped: absent the stored map the page must still say Full,
  // because the tier is read, never derived from the calling name. A
  // read-time classifier would contradict the minted claim, which
  // re-mints only on an access-doc write.
  it('renders Full on every importer row when the doc stores no limited map at all', () => {
    useStakeWardsMock.mockReturnValue(liveResult([{ ward_code: 'CO', ward_name: 'Maple' }]));
    useAccessListMock.mockReturnValue(
      liveResult([
        makeAccess({
          member_canonical: 'imp@x.com',
          member_email: 'imp@x.com',
          importer_callings: { CO: ['Bishop', 'Elders Quorum President'] },
          manual_grants: {},
        }),
      ]),
    );
    render(<AccessPage />);
    // Importer rows carry no grant_id, so the chip keys on scope + calling.
    expect(screen.getByTestId('access-table-level-imp@x.com-CO-Bishop')).toHaveTextContent('Full');
    expect(
      screen.getByTestId('access-table-level-imp@x.com-CO-Elders Quorum President'),
    ).toHaveTextContent('Full');
    expect(screen.getByTestId('access-grant-level-imp@x.com-CO-Bishop')).toHaveTextContent('Full');
    expect(
      screen.getByTestId('access-grant-level-imp@x.com-CO-Elders Quorum President'),
    ).toHaveTextContent('Full');
    // No row anywhere on the page claims the limited tier.
    expect(screen.queryByText('LIMITED')).toBeNull();
  });

  it('renders LIMITED on an importer calling stored in importer_limited_callings', () => {
    useStakeWardsMock.mockReturnValue(liveResult([{ ward_code: 'CO', ward_name: 'Maple' }]));
    useAccessListMock.mockReturnValue(
      liveResult([
        makeAccess({
          member_canonical: 'eqp@x.com',
          member_email: 'eqp@x.com',
          importer_callings: { CO: ['Elders Quorum President'] },
          importer_limited_callings: { CO: ['Elders Quorum President'] },
          manual_grants: {},
        }),
      ]),
    );
    render(<AccessPage />);
    // Table view — the chip lives in the Scope cell.
    const chip = screen.getByTestId('access-table-level-eqp@x.com-CO-Elders Quorum President');
    expect(chip).toHaveTextContent('LIMITED');
    const cells = Array.from(screen.getByTestId('access-table').querySelectorAll('tbody tr td'));
    expect(cells[0]).toContainElement(chip);
    // Card view — the chip sits beside the calling in the <li>.
    expect(
      screen.getByTestId('access-grant-level-eqp@x.com-CO-Elders Quorum President'),
    ).toHaveTextContent('LIMITED');
  });

  // A scope's stored list names a SUBSET of that scope's callings, so two
  // callings under one scope heading can disagree. A single-calling doc
  // could not catch a per-scope (rather than per-calling) regression.
  it('labels each calling in a mixed scope independently', () => {
    useStakeWardsMock.mockReturnValue(liveResult([{ ward_code: 'CO', ward_name: 'Maple' }]));
    useAccessListMock.mockReturnValue(
      liveResult([
        makeAccess({
          member_canonical: 'mixed@x.com',
          member_email: 'mixed@x.com',
          importer_callings: { CO: ['Bishop', 'Elders Quorum President'] },
          importer_limited_callings: { CO: ['Elders Quorum President'] },
          manual_grants: {},
        }),
      ]),
    );
    render(<AccessPage />);
    expect(screen.getByTestId('access-table-level-mixed@x.com-CO-Bishop')).toHaveTextContent(
      'Full',
    );
    expect(
      screen.getByTestId('access-table-level-mixed@x.com-CO-Elders Quorum President'),
    ).toHaveTextContent('LIMITED');
    // Same split in the card view: one <li> per calling, each with its
    // own chip.
    const card = screen.getByTestId('access-card-mixed@x.com');
    const items = Array.from(
      within(card).getByTestId('access-section-importer').querySelectorAll('li'),
    );
    expect(items.map((li) => li.textContent?.trim())).toEqual([
      'Bishop Full',
      'Elders Quorum President LIMITED',
    ]);
  });

  it('leaves manual rows on their own marker when the doc also stores a limited importer calling', () => {
    useStakeWardsMock.mockReturnValue(liveResult([{ ward_code: 'CO', ward_name: 'Maple' }]));
    useAccessListMock.mockReturnValue(
      liveResult([
        makeAccess({
          member_canonical: 'both@x.com',
          member_email: 'both@x.com',
          importer_callings: { CO: ['Elders Quorum President'] },
          importer_limited_callings: { CO: ['Elders Quorum President'] },
          manual_grants: {
            CO: [
              {
                grant_id: 'g-man',
                reason: 'Building scheduler',
                granted_by: { email: 'm@x.com', canonical: 'm@x.com' },
                granted_at: {
                  seconds: 0,
                  nanoseconds: 0,
                  toDate: () => new Date(),
                  toMillis: () => 0,
                },
              },
            ],
          },
        }),
      ]),
    );
    render(<AccessPage />);
    // The importer map never leaks onto the manual row.
    expect(
      screen.getByTestId('access-table-level-both@x.com-CO-Elders Quorum President'),
    ).toHaveTextContent('LIMITED');
    expect(screen.getByTestId('access-table-level-both@x.com-g-man')).toHaveTextContent('Full');
    expect(screen.getByTestId('access-grant-level-both@x.com-g-man')).toHaveTextContent('Full');
  });

  // Only positive evidence — the calling present in that scope's stored
  // list — reads as limited. Everything else degrades to Full without
  // throwing.
  describe('malformed importer_limited_callings', () => {
    function renderWith(limited: unknown) {
      useStakeWardsMock.mockReturnValue(liveResult([{ ward_code: 'CO', ward_name: 'Maple' }]));
      useAccessListMock.mockReturnValue(
        liveResult([
          makeAccess({
            member_canonical: 'bad@x.com',
            member_email: 'bad@x.com',
            importer_callings: { CO: ['Bishop', 'Elders Quorum President'] },
            importer_limited_callings: limited as Record<string, string[]>,
            manual_grants: {},
          }),
        ]),
      );
      render(<AccessPage />);
    }

    function tableLevels(): string[] {
      return Array.from(
        screen.getByTestId('access-table').querySelectorAll('[data-testid^="access-table-level-"]'),
      ).map((el) => el.textContent?.trim() ?? '');
    }

    it('reads Full when the map has no key for the row scope', () => {
      expect(() => renderWith({ GE: ['Elders Quorum President'] })).not.toThrow();
      expect(tableLevels()).toEqual(['Full', 'Full']);
    });

    it('reads Full when the scope value is not an array', () => {
      expect(() => renderWith({ CO: 'Elders Quorum President' })).not.toThrow();
      expect(tableLevels()).toEqual(['Full', 'Full']);
    });

    it('reads Full when the scope value is null', () => {
      expect(() => renderWith({ CO: null })).not.toThrow();
      expect(tableLevels()).toEqual(['Full', 'Full']);
    });

    it('ignores non-string entries in the scope list', () => {
      expect(() => renderWith({ CO: [null, 42, { name: 'Bishop' }] })).not.toThrow();
      expect(tableLevels()).toEqual(['Full', 'Full']);
    });

    it('adds no row for a listed name absent from importer_callings', () => {
      // The stored list is meant to be a subset; a name that is not in
      // `importer_callings` grants nothing and must not invent a row.
      renderWith({ CO: ['Stake President'] });
      const rows = Array.from(
        screen.getByTestId('access-table').querySelectorAll('tbody tr td:nth-child(2)'),
      ).map((td) => td.textContent?.trim());
      expect(rows).toEqual(['Bishop', 'Elders Quorum President']);
      expect(tableLevels()).toEqual(['Full', 'Full']);
    });

    it('reads Full when the scope list is empty', () => {
      renderWith({ CO: [] });
      expect(tableLevels()).toEqual(['Full', 'Full']);
    });
  });

  it('reads a manual row from the grant marker, never from its reason text', () => {
    const granted_by = { email: 'm@x.com', canonical: 'm@x.com' };
    const granted_at = { seconds: 0, nanoseconds: 0, toDate: () => new Date(), toMillis: () => 0 };
    useAccessListMock.mockReturnValue(
      liveResult([
        makeAccess({
          member_canonical: 'm@x.com',
          member_email: 'm@x.com',
          importer_callings: {},
          manual_grants: {
            stake: [
              // A reason that reads like a limited-tier calling is still a
              // full grant — only the stored `level` marker decides.
              {
                grant_id: 'g1',
                reason: 'Elders Quorum President',
                granted_by,
                granted_at,
              },
              {
                grant_id: 'g2',
                reason: 'Covering bishop',
                level: 'limited',
                granted_by,
                granted_at,
              },
            ],
          },
        }),
      ]),
    );
    render(<AccessPage />);
    expect(screen.getByTestId('access-table-level-m@x.com-g1')).toHaveTextContent('Full');
    expect(screen.getByTestId('access-table-level-m@x.com-g2')).toHaveTextContent('LIMITED');
  });

  it('badges a limited grant in both the table and the card view', () => {
    useAccessListMock.mockReturnValue(
      liveResult([
        makeAccess({
          member_canonical: 'lim@x.com',
          member_email: 'lim@x.com',
          importer_callings: {},
          manual_grants: {
            stake: [
              {
                grant_id: 'g-lim',
                reason: 'Covering bishop',
                level: 'limited',
                granted_by: { email: 'm@x.com', canonical: 'm@x.com' },
                granted_at: {
                  seconds: 0,
                  nanoseconds: 0,
                  toDate: () => new Date(),
                  toMillis: () => 0,
                },
              },
            ],
          },
        }),
      ]),
    );
    render(<AccessPage />);
    // Both views are always mounted; CSS picks which one is visible.
    expect(screen.getByTestId('access-table-level-lim@x.com-g-lim')).toHaveTextContent('LIMITED');
    expect(screen.getByTestId('access-grant-level-lim@x.com-g-lim')).toHaveTextContent('LIMITED');
  });

  it('keeps the card-view level chip beside the reason for both tiers', () => {
    const ts = { seconds: 0, nanoseconds: 0, toDate: () => new Date(), toMillis: () => 0 };
    const granted_by = { email: 'm@x.com', canonical: 'm@x.com' };
    useAccessListMock.mockReturnValue(
      liveResult([
        makeAccess({
          member_canonical: 'mix@x.com',
          member_email: 'mix@x.com',
          importer_callings: {},
          manual_grants: {
            stake: [
              { grant_id: 'g-full', reason: 'Helper', granted_by, granted_at: ts },
              {
                grant_id: 'g-lim',
                reason: 'Covering bishop',
                level: 'limited',
                granted_by,
                granted_at: ts,
              },
            ],
          },
        }),
      ]),
    );
    render(<AccessPage />);
    const card = screen.getByTestId('access-card-mix@x.com');
    // One <li> per grant; each carries its own chip next to its reason.
    const items = Array.from(
      within(card).getByTestId('access-section-manual').querySelectorAll('li'),
    );
    expect(items.map((li) => li.textContent?.replace(/Delete$/, '').trim())).toEqual([
      'Helper Full',
      'Covering bishop LIMITED',
    ]);
    expect(items[0]).toContainElement(screen.getByTestId('access-grant-level-mix@x.com-g-full'));
    expect(items[1]).toContainElement(screen.getByTestId('access-grant-level-mix@x.com-g-lim'));
  });

  // A doc can hold a full grant and a limited one at once. The chip is
  // per-grant, so the two rows must disagree — a single-grant doc could
  // not catch a per-doc (rather than per-grant) regression.
  it('badges each grant on its own tier when a doc holds both', () => {
    const ts = { seconds: 0, nanoseconds: 0, toDate: () => new Date(), toMillis: () => 0 };
    useAccessListMock.mockReturnValue(
      liveResult([
        makeAccess({
          member_canonical: 'both@x.com',
          member_email: 'both@x.com',
          importer_callings: {},
          manual_grants: {
            CO: [
              {
                grant_id: 'g-full',
                reason: 'Helper',
                granted_by: { email: 'm@x.com', canonical: 'm@x.com' },
                granted_at: ts,
              },
            ],
            stake: [],
            WM: [
              {
                grant_id: 'g-lim2',
                reason: 'Limited test',
                level: 'limited',
                granted_by: { email: 'm@x.com', canonical: 'm@x.com' },
                granted_at: ts,
              },
            ],
          },
        }),
      ]),
    );
    render(<AccessPage />);
    expect(screen.getByTestId('access-table-level-both@x.com-g-lim2')).toHaveTextContent('LIMITED');
    expect(screen.getByTestId('access-grant-level-both@x.com-g-lim2')).toHaveTextContent('LIMITED');
    expect(screen.getByTestId('access-table-level-both@x.com-g-full')).toHaveTextContent('Full');
    expect(screen.getByTestId('access-grant-level-both@x.com-g-full')).toHaveTextContent('Full');
  });

  it('opens the delete confirmation dialog when a grant Delete is clicked', async () => {
    const u = userEvent.setup();
    useAccessListMock.mockReturnValue(
      liveResult([
        makeAccess({
          manual_grants: {
            stake: [
              {
                grant_id: 'g1',
                reason: 'Covering bishop',
                granted_by: { email: 'm@x.com', canonical: 'm@x.com' },
                granted_at: {
                  seconds: 0,
                  nanoseconds: 0,
                  toDate: () => new Date(),
                  toMillis: () => 0,
                },
              },
            ],
          },
        }),
      ]),
    );
    render(<AccessPage />);
    const buttons = screen.getAllByRole('button', { name: /^Delete$/ });
    await u.click(buttons[0]!);
    expect(screen.getByText(/Remove manual access\?/i)).toBeInTheDocument();
    // Confirm via the dialog's Remove button.
    await u.click(screen.getByRole('button', { name: /^Remove$/ }));
    expect(deleteManualMutate).toHaveBeenCalled();
  });
});
