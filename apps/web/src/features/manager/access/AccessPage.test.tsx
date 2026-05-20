// Component tests for the Manager Access page.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Access } from '@kindoo/shared';
import { makeAccess } from '../../../../test/fixtures';

const useAccessListMock = vi.fn();
const useStakeWardsMock = vi.fn();
const useStakeCallingTemplatesMock = vi.fn();
const useWardCallingTemplatesMock = vi.fn();
const addManualMutate = vi.fn().mockResolvedValue(undefined);
const deleteManualMutate = vi.fn().mockResolvedValue(undefined);

vi.mock('./hooks', () => ({
  useAccessList: () => useAccessListMock(),
  useAddManualGrantMutation: () => ({ mutateAsync: addManualMutate, isPending: false }),
  useDeleteManualGrantMutation: () => ({ mutateAsync: deleteManualMutate, isPending: false }),
  useStakeCallingTemplates: () => useStakeCallingTemplatesMock(),
  useWardCallingTemplates: () => useWardCallingTemplatesMock(),
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
  // Default to empty template collections; specific tests override.
  useStakeCallingTemplatesMock.mockReturnValue(liveResult([]));
  useWardCallingTemplatesMock.mockReturnValue(liveResult([]));
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
        { ward_code: 'CO', ward_name: 'Cordera' },
        { ward_code: 'GE', ward_name: 'Genoa' },
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
        { ward_code: 'GE', ward_name: 'Genoa' },
        { ward_code: 'CO', ward_name: 'Cordera' },
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

  it('table view sorts rows by scope band, then per-row sheet_order from the calling-template lookup', () => {
    // Stake templates: Stake President = 1, Stake Clerk = 5.
    // Ward templates: Bishop = 1, Counselor = 3, EQ President = 7.
    useStakeCallingTemplatesMock.mockReturnValue(
      liveResult([
        {
          calling_name: 'Stake President',
          give_app_access: true,
          auto_kindoo_access: true,
          sheet_order: 1,
        },
        {
          calling_name: 'Stake Clerk',
          give_app_access: true,
          auto_kindoo_access: true,
          sheet_order: 5,
        },
      ]),
    );
    useWardCallingTemplatesMock.mockReturnValue(
      liveResult([
        { calling_name: 'Bishop', give_app_access: true, auto_kindoo_access: true, sheet_order: 1 },
        {
          calling_name: 'Counselor',
          give_app_access: true,
          auto_kindoo_access: true,
          sheet_order: 3,
        },
        {
          calling_name: 'EQ President',
          give_app_access: true,
          auto_kindoo_access: true,
          sheet_order: 7,
        },
      ]),
    );
    useStakeWardsMock.mockReturnValue(
      liveResult([
        { ward_code: 'CO', ward_name: 'Cordera' },
        { ward_code: 'GE', ward_name: 'Genoa' },
      ]),
    );
    useAccessListMock.mockReturnValue(
      liveResult([
        // Mixed users — assertions read every flat row.
        makeAccess({
          member_canonical: 'a@x.com',
          member_email: 'a@x.com',
          // Stake Clerk (5) — should land BELOW Stake President (1).
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
          // EQ President (7) → bottom of CO band.
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
      const cells = Array.from(tr.querySelectorAll('td')).map((td) => td.textContent?.trim() ?? '');
      return `${cells[0]}|${cells[1]}`;
    });
    expect(rows).toEqual([
      'stake|Stake President', // sheet_order 1
      'stake|Stake Clerk', // sheet_order 5
      'CO|Bishop', // sheet_order 1, CO band
      'CO|EQ President', // sheet_order 7, CO band
      'GE|Counselor', // GE band (only row)
    ]);
  });

  it('table view places manual grants at the bottom of their scope band (no template match)', () => {
    useStakeCallingTemplatesMock.mockReturnValue(
      liveResult([
        {
          calling_name: 'Stake President',
          give_app_access: true,
          auto_kindoo_access: true,
          sheet_order: 1,
        },
      ]),
    );
    useWardCallingTemplatesMock.mockReturnValue(liveResult([]));
    useStakeWardsMock.mockReturnValue(liveResult([{ ward_code: 'CO', ward_name: 'Cordera' }]));
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
      const cells = Array.from(tr.querySelectorAll('td')).map((td) => td.textContent?.trim() ?? '');
      return `${cells[0]}|${cells[1]}`;
    });
    expect(rows).toEqual([
      'stake|Stake President', // sheet_order 1
      'stake|Covering bishop', // manual → +Infinity → bottom of stake band
    ]);
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
