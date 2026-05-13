// Component tests for SyncPanel. Mocks the extensionApi boundary
// (getSyncData) + Kindoo client + the readKindooSession helper, then
// drives the panel through idle → loading → report / error.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const getSyncDataMock = vi.fn();
const readKindooSessionMock = vi.fn();
const listAllEnvironmentUsersMock = vi.fn();

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
  };
});

async function renderSync(onBack: () => void = () => undefined) {
  const { SyncPanel } = await import('./SyncPanel');
  return render(<SyncPanel email="mgr@example.com" onBack={onBack} />);
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
    readKindooSessionMock.mockReturnValue({
      ok: true,
      session: { token: 'sess', eid: 27994 },
    });
  });
  afterEach(() => {
    vi.resetModules();
  });

  it('renders idle state with a Run Sync button', async () => {
    await renderSync();
    expect(screen.getByTestId('sba-sync-idle')).toBeInTheDocument();
    expect(screen.getByTestId('sba-sync-run')).toBeInTheDocument();
  });

  it('Back to Queue button calls onBack', async () => {
    const user = userEvent.setup();
    const onBack = vi.fn();
    await renderSync(onBack);
    await user.click(screen.getByTestId('sba-sync-back'));
    expect(onBack).toHaveBeenCalledTimes(1);
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
});
