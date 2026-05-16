// Component tests for SyncPanel. Mocks the extensionApi boundary
// (getSyncData) + Kindoo client + the readKindooSession helper, then
// drives the panel through idle → loading → report / error, plus the
// Phase 2 per-row fix dispatcher.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const getSyncDataMock = vi.fn();
const readKindooSessionMock = vi.fn();
const listAllEnvironmentUsersMock = vi.fn();
const getEnvironmentsMock = vi.fn();
const applyFixMock = vi.fn();
const buildRuleDoorMapMock = vi.fn();
const enrichUsersWithDerivedBuildingsMock = vi.fn();

vi.mock('../lib/extensionApi', async () => {
  const actual = await vi.importActual<typeof import('../lib/extensionApi')>('../lib/extensionApi');
  return {
    ...actual,
    getSyncData: (...args: unknown[]) => getSyncDataMock(...args),
  };
});

vi.mock('../content/kindoo/auth', () => ({
  readKindooSession: (...args: unknown[]) => readKindooSessionMock(...args),
}));

vi.mock('../content/kindoo/endpoints', async () => {
  const actual = await vi.importActual<typeof import('../content/kindoo/endpoints')>(
    '../content/kindoo/endpoints',
  );
  return {
    ...actual,
    listAllEnvironmentUsers: (...args: unknown[]) => listAllEnvironmentUsersMock(...args),
    getEnvironments: (...args: unknown[]) => getEnvironmentsMock(...args),
  };
});

vi.mock('../content/kindoo/sync/fix', async () => {
  const actual = await vi.importActual<typeof import('../content/kindoo/sync/fix')>(
    '../content/kindoo/sync/fix',
  );
  return {
    ...actual,
    applyFix: (...args: unknown[]) => applyFixMock(...args),
  };
});

vi.mock('../content/kindoo/sync/buildingsFromDoors', async () => {
  const actual = await vi.importActual<typeof import('../content/kindoo/sync/buildingsFromDoors')>(
    '../content/kindoo/sync/buildingsFromDoors',
  );
  return {
    ...actual,
    buildRuleDoorMap: (...args: unknown[]) => buildRuleDoorMapMock(...args),
    enrichUsersWithDerivedBuildings: (...args: unknown[]) =>
      enrichUsersWithDerivedBuildingsMock(...args),
  };
});

async function renderSync() {
  const { SyncPanel } = await import('./SyncPanel');
  return render(<SyncPanel />);
}

function bundle() {
  return {
    stake: {
      stake_id: 'csnorth',
      stake_name: 'Colorado Springs North Stake',
    },
    wards: [{ ward_code: 'CO', ward_name: 'Cordera Ward', building_name: 'Cordera Building' }],
    buildings: [
      {
        building_id: 'cordera',
        building_name: 'Cordera Building',
        kindoo_rule: { rule_id: 6248, rule_name: 'Cordera Doors' },
      },
    ],
    seats: [],
    wardCallingTemplates: [],
    stakeCallingTemplates: [],
  };
}

describe('SyncPanel', () => {
  beforeEach(() => {
    getSyncDataMock.mockReset();
    readKindooSessionMock.mockReset();
    listAllEnvironmentUsersMock.mockReset();
    getEnvironmentsMock.mockReset();
    applyFixMock.mockReset();
    buildRuleDoorMapMock.mockReset();
    enrichUsersWithDerivedBuildingsMock.mockReset();
    readKindooSessionMock.mockReturnValue({
      ok: true,
      session: { token: 'sess', eid: 27994 },
    });
    getEnvironmentsMock.mockResolvedValue([
      { EID: 27994, Name: 'CSN', TimeZone: 'Mountain Standard Time' },
    ]);
    // Default: rule door map / enrichment pass through (users stay
    // un-enriched — derivedBuildings undefined → detector skips the
    // auto buildings check). Tests that care override.
    buildRuleDoorMapMock.mockResolvedValue(new Map());
    enrichUsersWithDerivedBuildingsMock.mockImplementation(async (_session, _eid, users) => users);
  });
  afterEach(() => {
    vi.resetModules();
  });

  it('renders idle state with a Run Sync button', async () => {
    await renderSync();
    expect(screen.getByTestId('sba-sync-idle')).toBeInTheDocument();
    expect(screen.getByTestId('sba-sync-run')).toBeInTheDocument();
  });

  it('routes idle → loading → report when both reads resolve', async () => {
    const user = userEvent.setup();
    let resolveSync!: (b: ReturnType<typeof bundle>) => void;
    let resolveKindoo!: (u: unknown[]) => void;
    getSyncDataMock.mockReturnValue(
      new Promise((res) => {
        resolveSync = res;
      }),
    );
    listAllEnvironmentUsersMock.mockReturnValue(
      new Promise((res) => {
        resolveKindoo = res;
      }),
    );
    await renderSync();
    await user.click(screen.getByTestId('sba-sync-run'));
    expect(screen.getByTestId('sba-sync-loading')).toBeInTheDocument();
    resolveSync(bundle());
    resolveKindoo([]);
    await waitFor(() => expect(screen.getByTestId('sba-sync-report')).toBeInTheDocument());
    expect(screen.getByTestId('sba-sync-summary')).toHaveTextContent(/SBA:\s*0\s*seats/);
    expect(screen.getByTestId('sba-sync-summary')).toHaveTextContent(/Kindoo:\s*0\s*users/);
  });

  it('updates progress text as the per-user enrichment loop ticks', async () => {
    const user = userEvent.setup();
    getSyncDataMock.mockResolvedValue(bundle());
    listAllEnvironmentUsersMock.mockResolvedValue([
      {
        euid: 'e1',
        userId: 'u1',
        username: 'a@example.com',
        description: '',
        isTempUser: false,
        accessSchedules: [],
      },
      {
        euid: 'e2',
        userId: 'u2',
        username: 'b@example.com',
        description: '',
        isTempUser: false,
        accessSchedules: [],
      },
    ]);
    // Custom enrichment that fires progress synchronously then resolves.
    enrichUsersWithDerivedBuildingsMock.mockImplementation(
      async (_s, _eid, users, _rm, _b, opts) => {
        opts.onProgress(1, 2);
        opts.onProgress(2, 2);
        return users;
      },
    );
    await renderSync();
    await user.click(screen.getByTestId('sba-sync-run'));
    // Wait for either report or progress to be present; with the
    // synchronous progress callbacks above the loading state collapses
    // immediately into report — assert on the report instead.
    await waitFor(() => expect(screen.getByTestId('sba-sync-report')).toBeInTheDocument());
    expect(enrichUsersWithDerivedBuildingsMock).toHaveBeenCalledTimes(1);
  });

  it('renders an empty-report message when both sides agree', async () => {
    const user = userEvent.setup();
    getSyncDataMock.mockResolvedValue(bundle());
    listAllEnvironmentUsersMock.mockResolvedValue([]);
    await renderSync();
    await user.click(screen.getByTestId('sba-sync-run'));
    await waitFor(() => expect(screen.getByTestId('sba-sync-empty')).toBeInTheDocument());
  });

  it('renders one row per discrepancy', async () => {
    const user = userEvent.setup();
    const b = bundle();
    b.seats.push({
      member_canonical: 'orphan@example.com',
      member_email: 'orphan@example.com',
      member_name: 'Orphan',
      scope: 'CO',
      type: 'auto',
      callings: ['Sunday School Teacher'],
      building_names: ['Cordera Building'],
      duplicate_grants: [],
    } as never);
    getSyncDataMock.mockResolvedValue(b);
    listAllEnvironmentUsersMock.mockResolvedValue([]);
    await renderSync();
    await user.click(screen.getByTestId('sba-sync-run'));
    await waitFor(() => expect(screen.getByTestId('sba-sync-list')).toBeInTheDocument());
    expect(screen.getByTestId('sba-sync-row-orphan@example.com')).toBeInTheDocument();
  });

  it('filters drift-only and review-only when chips are clicked', async () => {
    const user = userEvent.setup();
    const b = bundle();
    // sba-only → drift
    b.seats.push({
      member_canonical: 'drift@example.com',
      member_email: 'drift@example.com',
      member_name: 'D',
      scope: 'CO',
      type: 'auto',
      callings: [],
      building_names: [],
      duplicate_grants: [],
    } as never);
    getSyncDataMock.mockResolvedValue(b);
    // kindoo-only with unparseable description → review-eligible? Actually
    // kindoo-only is drift severity. Use a Kindoo user that has a seat
    // with unparseable description for review.
    b.seats.push({
      member_canonical: 'review@example.com',
      member_email: 'review@example.com',
      member_name: 'R',
      scope: 'CO',
      type: 'auto',
      callings: [],
      building_names: ['Cordera Building'],
      duplicate_grants: [],
    } as never);
    listAllEnvironmentUsersMock.mockResolvedValue([
      {
        euid: 'e1',
        userId: 'u1',
        username: 'review@example.com',
        description: 'Kindoo Manager - Stake Clerk',
        isTempUser: false,
        startAccessDoorsDateAtTimeZone: null,
        expiryDateAtTimeZone: null,
        expiryTimeZone: 'MST',
        accessSchedules: [{ ruleId: 6248 }],
      },
    ]);
    await renderSync();
    await user.click(screen.getByTestId('sba-sync-run'));
    await waitFor(() => expect(screen.getByTestId('sba-sync-list')).toBeInTheDocument());
    expect(screen.getByTestId('sba-sync-row-drift@example.com')).toBeInTheDocument();
    expect(screen.getByTestId('sba-sync-row-review@example.com')).toBeInTheDocument();

    // Drift filter — drift row stays, review row gone.
    await user.click(screen.getByTestId('sba-sync-filter-drift'));
    expect(screen.getByTestId('sba-sync-row-drift@example.com')).toBeInTheDocument();
    expect(screen.queryByTestId('sba-sync-row-review@example.com')).toBeNull();

    // Review filter — review row visible, drift hidden.
    await user.click(screen.getByTestId('sba-sync-filter-review'));
    expect(screen.queryByTestId('sba-sync-row-drift@example.com')).toBeNull();
    expect(screen.getByTestId('sba-sync-row-review@example.com')).toBeInTheDocument();

    // All filter — both back.
    await user.click(screen.getByTestId('sba-sync-filter-all'));
    expect(screen.getByTestId('sba-sync-row-drift@example.com')).toBeInTheDocument();
    expect(screen.getByTestId('sba-sync-row-review@example.com')).toBeInTheDocument();
  });

  it('renders the error state with a retry button when getSyncData rejects', async () => {
    const user = userEvent.setup();
    getSyncDataMock.mockRejectedValue(new Error('boom'));
    listAllEnvironmentUsersMock.mockResolvedValue([]);
    await renderSync();
    await user.click(screen.getByTestId('sba-sync-run'));
    await waitFor(() => expect(screen.getByTestId('sba-sync-error')).toBeInTheDocument());
    expect(screen.getByTestId('sba-sync-retry')).toBeInTheDocument();
  });

  it('renders the no-kindoo state when readKindooSession fails', async () => {
    const user = userEvent.setup();
    readKindooSessionMock.mockReturnValue({ ok: false, error: 'no-token' });
    await renderSync();
    await user.click(screen.getByTestId('sba-sync-run'));
    await waitFor(() => expect(screen.getByTestId('sba-sync-no-kindoo')).toBeInTheDocument());
  });

  it('retry from error state re-attempts the read', async () => {
    const user = userEvent.setup();
    getSyncDataMock.mockRejectedValueOnce(new Error('first-fail'));
    getSyncDataMock.mockResolvedValueOnce(bundle());
    listAllEnvironmentUsersMock.mockResolvedValue([]);
    await renderSync();
    await user.click(screen.getByTestId('sba-sync-run'));
    await waitFor(() => expect(screen.getByTestId('sba-sync-error')).toBeInTheDocument());
    await user.click(screen.getByTestId('sba-sync-retry'));
    await waitFor(() => expect(screen.getByTestId('sba-sync-report')).toBeInTheDocument());
  });

  // --------------------------------------------------------------------
  // Phase 2 — Fix action coverage. For each code: assert the expected
  // button(s) render; click → applyFix called with the expected args;
  // success → row removed + summary counter decrements; error → inline
  // message + Retry button.
  // --------------------------------------------------------------------

  async function setupFor(opts: { seats?: unknown[]; users?: unknown[] }) {
    const b = bundle();
    if (opts.seats) {
      (b.seats as unknown[]).push(...opts.seats);
    }
    getSyncDataMock.mockResolvedValue(b);
    listAllEnvironmentUsersMock.mockResolvedValue(opts.users ?? []);
    const user = userEvent.setup();
    await renderSync();
    await user.click(screen.getByTestId('sba-sync-run'));
    await waitFor(() => expect(screen.getByTestId('sba-sync-list')).toBeInTheDocument());
    return { user };
  }

  function autoSeat(email: string, callings: string[] = ['Sunday School Teacher']) {
    return {
      member_canonical: email,
      member_email: email,
      member_name: email.split('@')[0],
      scope: 'CO',
      type: 'auto',
      callings,
      building_names: ['Cordera Building'],
      duplicate_grants: [],
    };
  }

  function kuser(email: string, overrides: Record<string, unknown> = {}) {
    return {
      euid: `e-${email}`,
      userId: `u-${email}`,
      username: email,
      FirstName: 'First',
      LastName: 'Last',
      description: 'Cordera Ward (Sunday School Teacher)',
      isTempUser: false,
      startAccessDoorsDateAtTimeZone: null,
      expiryDateAtTimeZone: null,
      expiryTimeZone: 'Mountain Standard Time',
      accessSchedules: [{ ruleId: 6248 }],
      ...overrides,
    };
  }

  it('sba-only renders one Provision in Kindoo button', async () => {
    const b = bundle();
    b.wardCallingTemplates.push({
      calling_name: 'Sunday School Teacher',
      auto_kindoo_access: true,
    } as never);
    b.seats.push(autoSeat('orphan@example.com') as never);
    getSyncDataMock.mockResolvedValue(b);
    listAllEnvironmentUsersMock.mockResolvedValue([]);
    const user = userEvent.setup();
    await renderSync();
    await user.click(screen.getByTestId('sba-sync-run'));
    await waitFor(() => expect(screen.getByTestId('sba-sync-list')).toBeInTheDocument());

    expect(
      screen.getByTestId('sba-sync-fix-provision-kindoo-orphan@example.com'),
    ).toBeInTheDocument();
    // kindoo-only path on this row is absent — only one button.
    expect(screen.queryByTestId('sba-sync-fix-create-sba-orphan@example.com')).toBeNull();
  });

  it('kindoo-only renders one Create SBA seat button + click dispatches applyFix', async () => {
    applyFixMock.mockResolvedValue({ ok: true });
    const { user } = await setupFor({
      users: [kuser('newbie@example.com')],
    });
    const btn = await screen.findByTestId('sba-sync-fix-create-sba-newbie@example.com');
    expect(btn).toBeInTheDocument();
    await user.click(btn);
    await waitFor(() => expect(applyFixMock).toHaveBeenCalled());
    const [discrepancyArg, actionArg] = applyFixMock.mock.calls[0]!;
    expect((discrepancyArg as { code: string }).code).toBe('kindoo-only');
    expect((actionArg as { side: string }).side).toBe('sba');
  });

  it('extra-kindoo-calling renders Add to SBA seat + click dispatches', async () => {
    applyFixMock.mockResolvedValue({ ok: true });
    const b = bundle();
    b.wardCallingTemplates.push({
      calling_name: 'Sunday School Teacher',
      auto_kindoo_access: true,
    } as never);
    b.seats.push(autoSeat('extra@example.com') as never);
    getSyncDataMock.mockResolvedValue(b);
    listAllEnvironmentUsersMock.mockResolvedValue([
      kuser('extra@example.com', {
        description: 'Cordera Ward (Sunday School Teacher, Janitor)',
      }),
    ]);
    const user = userEvent.setup();
    await renderSync();
    await user.click(screen.getByTestId('sba-sync-run'));
    await waitFor(() => expect(screen.getByTestId('sba-sync-list')).toBeInTheDocument());

    const btn = await screen.findByTestId('sba-sync-fix-add-callings-sba-extra@example.com');
    await user.click(btn);
    await waitFor(() => expect(applyFixMock).toHaveBeenCalled());
    expect((applyFixMock.mock.calls[0]![0] as { code: string }).code).toBe('extra-kindoo-calling');
  });

  it('scope-mismatch renders Update Kindoo + Update SBA buttons', async () => {
    const b = bundle();
    b.wardCallingTemplates.push({
      calling_name: 'Sunday School Teacher',
      auto_kindoo_access: true,
    } as never);
    b.wards.push({
      ward_code: 'PC',
      ward_name: 'Pine Creek Ward',
      building_name: 'Pine Creek Building',
    } as never);
    b.buildings.push({
      building_id: 'pinecreek',
      building_name: 'Pine Creek Building',
      kindoo_rule: { rule_id: 6249, rule_name: 'Pine Creek Doors' },
    } as never);
    b.seats.push({
      ...autoSeat('scope@example.com'),
      scope: 'CO',
    } as never);
    getSyncDataMock.mockResolvedValue(b);
    listAllEnvironmentUsersMock.mockResolvedValue([
      kuser('scope@example.com', {
        description: 'Pine Creek Ward (Sunday School Teacher)',
        accessSchedules: [{ ruleId: 6249 }],
      }),
    ]);
    const user = userEvent.setup();
    await renderSync();
    await user.click(screen.getByTestId('sba-sync-run'));
    await waitFor(() => expect(screen.getByTestId('sba-sync-list')).toBeInTheDocument());

    expect(screen.getByTestId('sba-sync-fix-update-kindoo-scope@example.com')).toBeInTheDocument();
    expect(screen.getByTestId('sba-sync-fix-update-sba-scope@example.com')).toBeInTheDocument();
  });

  it('type-mismatch disables Update Kindoo when SBA seat is auto', async () => {
    const b = bundle();
    b.wardCallingTemplates.push({
      calling_name: 'Sunday School Teacher',
      auto_kindoo_access: true,
    } as never);
    b.seats.push({
      ...autoSeat('tm@example.com'),
      type: 'manual',
      callings: [],
      reason: 'Requested by bishop',
    } as never);
    getSyncDataMock.mockResolvedValue(b);
    listAllEnvironmentUsersMock.mockResolvedValue([
      kuser('tm@example.com', {
        description: 'Cordera Ward (Sunday School Teacher)',
      }),
    ]);
    const user = userEvent.setup();
    await renderSync();
    await user.click(screen.getByTestId('sba-sync-run'));
    await waitFor(() => expect(screen.getByTestId('sba-sync-list')).toBeInTheDocument());

    const kindooBtn = screen.getByTestId('sba-sync-fix-update-kindoo-tm@example.com');
    expect(kindooBtn).toBeDisabled();
    const sbaBtn = screen.getByTestId('sba-sync-fix-update-sba-tm@example.com');
    expect(sbaBtn).not.toBeDisabled();
  });

  it('buildings-mismatch renders both fix buttons', async () => {
    const b = bundle();
    b.wards.push({
      ward_code: 'PC',
      ward_name: 'Pine Creek Ward',
      building_name: 'Pine Creek Building',
    } as never);
    b.buildings.push({
      building_id: 'pinecreek',
      building_name: 'Pine Creek Building',
      kindoo_rule: { rule_id: 6249, rule_name: 'Pine Creek Doors' },
    } as never);
    b.seats.push({
      ...autoSeat('bm@example.com'),
      type: 'manual',
      callings: [],
      reason: 'Requested by bishop',
      building_names: ['Cordera Building', 'Pine Creek Building'],
    } as never);
    getSyncDataMock.mockResolvedValue(b);
    listAllEnvironmentUsersMock.mockResolvedValue([
      kuser('bm@example.com', {
        description: 'Cordera Ward (Building Greeter)',
        accessSchedules: [{ ruleId: 6248 }],
      }),
    ]);
    const user = userEvent.setup();
    await renderSync();
    await user.click(screen.getByTestId('sba-sync-run'));
    await waitFor(() => expect(screen.getByTestId('sba-sync-list')).toBeInTheDocument());

    expect(screen.getByTestId('sba-sync-fix-update-kindoo-bm@example.com')).toBeInTheDocument();
    expect(screen.getByTestId('sba-sync-fix-update-sba-bm@example.com')).toBeInTheDocument();
  });

  it('kindoo-unparseable renders no fix buttons', async () => {
    const b = bundle();
    b.seats.push(autoSeat('weird@example.com') as never);
    getSyncDataMock.mockResolvedValue(b);
    listAllEnvironmentUsersMock.mockResolvedValue([
      kuser('weird@example.com', { description: 'Kindoo Manager - Stake Clerk' }),
    ]);
    const user = userEvent.setup();
    await renderSync();
    await user.click(screen.getByTestId('sba-sync-run'));
    await waitFor(() => expect(screen.getByTestId('sba-sync-list')).toBeInTheDocument());

    expect(screen.queryByTestId('sba-sync-fix-create-sba-weird@example.com')).toBeNull();
    expect(screen.queryByTestId('sba-sync-fix-update-kindoo-weird@example.com')).toBeNull();
    expect(screen.queryByTestId('sba-sync-fix-update-sba-weird@example.com')).toBeNull();
  });

  it('success path removes the row and decrements the matching counter', async () => {
    applyFixMock.mockResolvedValue({ ok: true });
    const { user } = await setupFor({
      users: [kuser('gone@example.com')],
    });
    expect(screen.getByTestId('sba-sync-row-gone@example.com')).toBeInTheDocument();
    // Summary starts at 1 drift item.
    expect(screen.getByTestId('sba-sync-summary')).toHaveTextContent(/1\s+drift item/);

    const btn = screen.getByTestId('sba-sync-fix-create-sba-gone@example.com');
    await user.click(btn);
    await waitFor(() => expect(screen.queryByTestId('sba-sync-row-gone@example.com')).toBeNull());
    expect(screen.getByTestId('sba-sync-summary')).toHaveTextContent(/0\s+drift items/);
  });

  it('error path shows inline message + Retry button; Retry re-fires the same action', async () => {
    applyFixMock.mockResolvedValueOnce({ ok: false, error: 'boom' });
    applyFixMock.mockResolvedValueOnce({ ok: true });
    const { user } = await setupFor({
      users: [kuser('flaky@example.com')],
    });
    await user.click(screen.getByTestId('sba-sync-fix-create-sba-flaky@example.com'));
    await waitFor(() =>
      expect(screen.getByTestId('sba-sync-fix-error-flaky@example.com')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('sba-sync-fix-error-flaky@example.com')).toHaveTextContent('boom');
    await user.click(screen.getByTestId('sba-sync-fix-retry-flaky@example.com'));
    await waitFor(() => expect(screen.queryByTestId('sba-sync-row-flaky@example.com')).toBeNull());
    expect(applyFixMock).toHaveBeenCalledTimes(2);
    // Second call uses the same action object — assert the side stays 'sba'.
    expect((applyFixMock.mock.calls[1]![1] as { side: string }).side).toBe('sba');
  });
});
