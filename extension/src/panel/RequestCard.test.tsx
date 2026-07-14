// Component tests for the v2.2 RequestCard. Mocks the provision
// module (`content/kindoo/provision`) and the `markRequestComplete`
// SW wrapper. Asserts:
//   - button label varies by request.type
//   - clicking triggers provision → markRequestComplete → result dialog
//   - error states render inline and re-enable the button
//   - Kindoo-OK + SBA-fail surfaces a partial-success dialog with a
//     retry button that calls markRequestComplete only
//   - dismiss calls onDismissed with the request id

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const provisionAddOrChangeMock = vi.fn();
const provisionRemoveMock = vi.fn();
const provisionEditMock = vi.fn();
const getEnvironmentsMock = vi.fn();
const readKindooSessionMock = vi.fn();
const markRequestCompleteMock = vi.fn();
const getSeatByEmailMock = vi.fn();
const getAccessByEmailMock = vi.fn();
const writeKindooSiteEidMock = vi.fn();
const rejectRequestMock = vi.fn();

vi.mock('../content/kindoo/provision', async () => {
  const actual = await vi.importActual<typeof import('../content/kindoo/provision')>(
    '../content/kindoo/provision',
  );
  return {
    ...actual,
    provisionAddOrChange: (...args: unknown[]) => provisionAddOrChangeMock(...args),
    provisionRemove: (...args: unknown[]) => provisionRemoveMock(...args),
    provisionEdit: (...args: unknown[]) => provisionEditMock(...args),
  };
});

vi.mock('../content/kindoo/endpoints', async () => {
  const actual = await vi.importActual<typeof import('../content/kindoo/endpoints')>(
    '../content/kindoo/endpoints',
  );
  return {
    ...actual,
    getEnvironments: (...args: unknown[]) => getEnvironmentsMock(...args),
  };
});

vi.mock('../content/kindoo/auth', () => ({
  readKindooSession: (...args: unknown[]) => readKindooSessionMock(...args),
}));

vi.mock('../lib/extensionApi', async () => {
  const actual = await vi.importActual<typeof import('../lib/extensionApi')>('../lib/extensionApi');
  return {
    ...actual,
    markRequestComplete: (...args: unknown[]) => markRequestCompleteMock(...args),
    getSeatByEmail: (...args: unknown[]) => getSeatByEmailMock(...args),
    getAccessByEmail: (...args: unknown[]) => getAccessByEmailMock(...args),
    writeKindooSiteEid: (...args: unknown[]) => writeKindooSiteEidMock(...args),
    rejectRequest: (...args: unknown[]) => rejectRequestMock(...args),
  };
});

import type { Access, AccessRequest } from '@kindoo/shared';
import type { StakeConfigBundle } from '../lib/extensionApi';

/**
 * Minimal `access` doc — only the fields `deriveRequesterDisplay` reads
 * (member_name + importer_callings / manual_grants). Bookkeeping fields
 * are irrelevant to the requester-label derivation, so the cast keeps
 * the fixture focused.
 */
function accessDoc(overrides: Partial<Access> = {}): Access {
  return {
    member_canonical: 'requester@example.com',
    member_email: 'requester@example.com',
    member_name: '',
    importer_callings: {},
    manual_grants: {},
    ...overrides,
  } as Access;
}

function bundle(): StakeConfigBundle {
  return {
    stake: {
      stake_id: 'csnorth',
      stake_name: 'Colorado Springs North Stake',
      // Home-site EID — site check runs first on every provision and
      // demands `kindoo_config.site_id` for stake-scope / home-ward
      // resolution.
      kindoo_config: {
        site_id: 27994,
        site_name: 'Colorado Springs North Stake',
      },
    } as unknown as StakeConfigBundle['stake'],
    buildings: [
      {
        building_id: 'maple',
        building_name: 'Maple Building',
        kindoo_rule: { rule_id: 6248, rule_name: 'Maple Doors' },
      },
    ] as unknown as StakeConfigBundle['buildings'],
    wards: [],
    kindooSites: [],
  };
}

function addRequest(overrides: Partial<AccessRequest> = {}): AccessRequest {
  return {
    request_id: 'r1',
    type: 'add_manual',
    scope: 'stake',
    member_email: 'tad.e.smith@gmail.com',
    member_canonical: 'tad.e.smith@gmail.com',
    member_name: 'Test User',
    reason: 'Sunday School Teacher',
    comment: '',
    building_names: ['Maple Building'],
    status: 'pending',
    requester_email: 'requester@example.com',
    requester_canonical: 'requester@example.com',
    requested_at: { seconds: 1, nanoseconds: 0 } as unknown as AccessRequest['requested_at'],
    lastActor: { email: 'r@x', canonical: 'r@x' },
    ...overrides,
  } as AccessRequest;
}

function removeReq(overrides: Partial<AccessRequest> = {}): AccessRequest {
  return addRequest({ request_id: 'r2', type: 'remove', ...overrides });
}

function editReq(overrides: Partial<AccessRequest> = {}): AccessRequest {
  return addRequest({ request_id: 'r3', type: 'edit_manual', ...overrides });
}

async function renderCard(
  opts: {
    request?: AccessRequest;
    bundle?: StakeConfigBundle;
    onDismissed?: (id: string) => void;
    memberHasSeat?: boolean;
    memberHasStakeGrant?: boolean;
    memberSeatAbsent?: boolean;
  } = {},
) {
  const { RequestCard } = await import('./RequestCard');
  return render(
    <RequestCard
      stakeId="csnorth"
      request={opts.request ?? addRequest()}
      bundle={opts.bundle ?? bundle()}
      memberHasSeat={opts.memberHasSeat ?? false}
      memberHasStakeGrant={opts.memberHasStakeGrant ?? false}
      memberSeatAbsent={opts.memberSeatAbsent ?? false}
      onDismissed={opts.onDismissed ?? vi.fn()}
    />,
  );
}

/** Bundle whose wards catalogue resolves the `CO` ward code to a name. */
function bundleWithWards(): StakeConfigBundle {
  return {
    ...bundle(),
    wards: [{ ward_code: 'CO', ward_name: 'Maple Ward' }] as unknown as StakeConfigBundle['wards'],
  };
}

describe('RequestCard', () => {
  beforeEach(() => {
    provisionAddOrChangeMock.mockReset();
    provisionRemoveMock.mockReset();
    provisionEditMock.mockReset();
    getEnvironmentsMock.mockReset();
    readKindooSessionMock.mockReset();
    markRequestCompleteMock.mockReset();
    getSeatByEmailMock.mockReset();
    getAccessByEmailMock.mockReset();
    writeKindooSiteEidMock.mockReset();
    rejectRequestMock.mockReset();
    readKindooSessionMock.mockReturnValue({ ok: true, session: { token: 'tok', eid: 27994 } });
    getEnvironmentsMock.mockResolvedValue([
      { EID: 27994, Name: 'Colorado Springs North Stake', TimeZone: 'Mountain Standard Time' },
    ]);
    // Default: subject has no SBA seat yet (first-time-add path);
    // individual tests override when they need a populated seat.
    getSeatByEmailMock.mockResolvedValue(null);
    // Default: requester has no access doc → the "Requester:" line falls
    // back to the raw email. Tests that assert name / calling override.
    getAccessByEmailMock.mockResolvedValue(null);
  });
  afterEach(() => {
    vi.resetModules();
  });

  it('labels add_manual cards "Add Kindoo Access"', async () => {
    await renderCard();
    expect(screen.getByTestId('sba-add-r1')).toHaveTextContent('Add Kindoo Access');
  });

  it('labels add_temp cards "Add Kindoo Access" (same flow as manual)', async () => {
    await renderCard({
      request: addRequest({ type: 'add_temp', start_date: '2026-05-13', end_date: '2026-05-14' }),
    });
    expect(screen.getByTestId('sba-add-r1')).toHaveTextContent('Add Kindoo Access');
  });

  it('labels remove cards "Remove Kindoo Access"', async () => {
    await renderCard({ request: removeReq() });
    expect(screen.getByTestId('sba-remove-r2')).toHaveTextContent('Remove Kindoo Access');
  });

  it('renders the ward NAME for a ward-scope request when wards resolve', async () => {
    await renderCard({ request: addRequest({ scope: 'CO' }), bundle: bundleWithWards() });
    const card = screen.getByTestId('sba-request-r1');
    expect(card).toHaveTextContent('Maple Ward');
    expect(card).not.toHaveTextContent('CO');
  });

  it('renders "Stake" for the stake scope', async () => {
    await renderCard({ request: addRequest({ scope: 'stake' }), bundle: bundleWithWards() });
    expect(screen.getByTestId('sba-request-r1')).toHaveTextContent('Stake');
  });

  it('falls back to the raw scope code when the ward is not in the catalogue', async () => {
    await renderCard({ request: addRequest({ scope: 'ZZ' }), bundle: bundleWithWards() });
    expect(screen.getByTestId('sba-request-r1')).toHaveTextContent('ZZ');
  });

  it('falls back to the raw scope code when the wards catalogue is empty', async () => {
    // Default bundle() ships `wards: []`.
    await renderCard({ request: addRequest({ scope: 'CO' }) });
    expect(screen.getByTestId('sba-request-r1')).toHaveTextContent('CO');
  });

  // ---- Requester line (name + calling, live-derived) ----------------

  it("renders the requester's name and calling derived from their access doc", async () => {
    // Default addRequest scope is 'stake'; the calling is recorded under
    // that scope, so it surfaces.
    getAccessByEmailMock.mockResolvedValue(
      accessDoc({ member_name: 'Bishop Bob', importer_callings: { stake: ['Bishop'] } }),
    );
    await renderCard();
    const card = screen.getByTestId('sba-request-r1');
    await waitFor(() => expect(card.textContent).toMatch(/Requester:\s*Bishop Bob \(Bishop\)/));
    // The raw requester email is replaced, not appended.
    expect(card.textContent).not.toMatch(/requester@example\.com/);
    expect(getAccessByEmailMock).toHaveBeenCalledWith('csnorth', 'requester@example.com');
  });

  it('renders the requester name alone when they have no calling for the scope', async () => {
    // Calling is recorded under 'CO', but the request's scope is 'stake'
    // → no calling applies → name only (no parenthesised calling, no
    // email fallback).
    getAccessByEmailMock.mockResolvedValue(
      accessDoc({ member_name: 'Bishop Bob', importer_callings: { CO: ['Bishop'] } }),
    );
    await renderCard();
    const card = screen.getByTestId('sba-request-r1');
    await waitFor(() => expect(card.textContent).toMatch(/Requester:\s*Bishop Bob/));
    expect(card.textContent).not.toMatch(/Requester:\s*Bishop Bob\s*\(/);
    expect(card.textContent).not.toMatch(/requester@example\.com/);
  });

  it('falls back to the requester email when the requester has no access doc', async () => {
    // Default getAccessByEmailMock resolves null.
    await renderCard();
    const card = screen.getByTestId('sba-request-r1');
    await waitFor(() => expect(getAccessByEmailMock).toHaveBeenCalled());
    expect(card.textContent).toMatch(/Requester:\s*requester@example\.com/);
  });

  it('runs provisionAddOrChange and markRequestComplete on click, then shows the result dialog', async () => {
    provisionAddOrChangeMock.mockResolvedValue({
      kindoo_uid: 'new-uid',
      action: 'invited',
      note: 'Added Test User to Kindoo with access to Maple Building.',
    });
    markRequestCompleteMock.mockResolvedValue({ ok: true });

    const user = userEvent.setup();
    await renderCard();
    await user.click(screen.getByTestId('sba-add-r1'));

    await waitFor(() => expect(screen.getByTestId('sba-result-dialog')).toBeInTheDocument());
    expect(screen.getByTestId('sba-result-note')).toHaveTextContent(
      'Added Test User to Kindoo with access to Maple Building.',
    );
    expect(markRequestCompleteMock).toHaveBeenCalledWith({
      stakeId: 'csnorth',
      requestId: 'r1',
      completionNote: 'Added Test User to Kindoo with access to Maple Building.',
      provisioningNote: 'Added Test User to Kindoo with access to Maple Building.',
      kindooUid: 'new-uid',
    });
  });

  it('runs provisionRemove (with envs fetch — needed for editUser timezone) for remove-type requests', async () => {
    provisionRemoveMock.mockResolvedValue({
      kindoo_uid: 'removed-uid',
      action: 'removed',
      note: 'Removed Test User from Kindoo.',
    });
    markRequestCompleteMock.mockResolvedValue({ ok: true });

    const user = userEvent.setup();
    await renderCard({ request: removeReq() });
    await user.click(screen.getByTestId('sba-remove-r2'));

    await waitFor(() => expect(screen.getByTestId('sba-result-dialog')).toBeInTheDocument());
    // v2.2 scope-aware remove needs envs for editUser's timezone passthrough.
    expect(getEnvironmentsMock).toHaveBeenCalledTimes(1);
    expect(provisionRemoveMock).toHaveBeenCalledTimes(1);
  });

  it('omits kindooUid when provision returned a noop-remove (null UID)', async () => {
    provisionRemoveMock.mockResolvedValue({
      kindoo_uid: null,
      action: 'noop-remove',
      note: 'Test User was not in Kindoo (no-op).',
    });
    markRequestCompleteMock.mockResolvedValue({ ok: true });

    const user = userEvent.setup();
    await renderCard({ request: removeReq() });
    await user.click(screen.getByTestId('sba-remove-r2'));

    await waitFor(() => expect(markRequestCompleteMock).toHaveBeenCalledTimes(1));
    const payload = markRequestCompleteMock.mock.calls[0]![0];
    expect(payload.kindooUid).toBeUndefined();
    expect(payload.provisioningNote).toBe('Test User was not in Kindoo (no-op).');
  });

  it('disables the button + shows the spinner label during provisioning', async () => {
    const resolvers: Array<(result: unknown) => void> = [];
    provisionAddOrChangeMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
        }),
    );
    markRequestCompleteMock.mockResolvedValue({ ok: true });

    const user = userEvent.setup();
    await renderCard();
    await user.click(screen.getByTestId('sba-add-r1'));

    const btn = screen.getByTestId('sba-add-r1');
    await waitFor(() => expect(btn).toBeDisabled());
    expect(btn).toHaveTextContent('Add Kindoo Access…');

    // Let the provision resolve so the test can finish cleanly.
    resolvers[0]?.({ kindoo_uid: 'u', action: 'invited', note: 'note' });
  });

  it('renders an inline error and re-enables the button when provision throws', async () => {
    provisionAddOrChangeMock.mockRejectedValue(new Error('Kindoo down'));

    const user = userEvent.setup();
    await renderCard();
    await user.click(screen.getByTestId('sba-add-r1'));

    await waitFor(() => expect(screen.getByTestId('sba-provision-error-r1')).toBeInTheDocument());
    expect(screen.getByTestId('sba-provision-error-r1')).toHaveTextContent('Kindoo down');
    expect(screen.getByTestId('sba-add-r1')).toBeEnabled();
    expect(markRequestCompleteMock).not.toHaveBeenCalled();
  });

  it('renders a "sign into Kindoo" error when localStorage has no token', async () => {
    readKindooSessionMock.mockReturnValue({ ok: false, error: 'no-token' });

    const user = userEvent.setup();
    await renderCard();
    await user.click(screen.getByTestId('sba-add-r1'));

    await waitFor(() =>
      expect(screen.getByTestId('sba-provision-error-r1')).toHaveTextContent(/Sign into Kindoo/),
    );
    expect(provisionAddOrChangeMock).not.toHaveBeenCalled();
  });

  it('shows a partial-success dialog when Kindoo succeeds but markRequestComplete fails', async () => {
    provisionAddOrChangeMock.mockResolvedValue({
      kindoo_uid: 'new-uid',
      action: 'invited',
      note: 'Added Test User to Kindoo with access to Maple Building.',
    });
    markRequestCompleteMock.mockRejectedValueOnce(new Error('SBA down'));

    const user = userEvent.setup();
    await renderCard();
    await user.click(screen.getByTestId('sba-add-r1'));

    await waitFor(() => expect(screen.getByTestId('sba-result-dialog')).toBeInTheDocument());
    expect(screen.getByTestId('sba-result-partial-error')).toHaveTextContent('SBA down');
    expect(screen.getByTestId('sba-result-retry')).toBeInTheDocument();
  });

  it('retry button re-calls markRequestComplete (only — no second Kindoo call)', async () => {
    provisionAddOrChangeMock.mockResolvedValue({
      kindoo_uid: 'new-uid',
      action: 'invited',
      note: 'Added Test User to Kindoo with access to Maple Building.',
    });
    markRequestCompleteMock
      .mockRejectedValueOnce(new Error('SBA down'))
      .mockResolvedValueOnce({ ok: true });

    const user = userEvent.setup();
    await renderCard();
    await user.click(screen.getByTestId('sba-add-r1'));

    await waitFor(() => expect(screen.getByTestId('sba-result-retry')).toBeInTheDocument());
    await user.click(screen.getByTestId('sba-result-retry'));

    await waitFor(() => expect(markRequestCompleteMock).toHaveBeenCalledTimes(2));
    expect(provisionAddOrChangeMock).toHaveBeenCalledTimes(1); // no re-Kindoo
    // After retry succeeds, the dialog flips to the ok branch (no
    // partial-error text remains).
    expect(screen.queryByTestId('sba-result-partial-error')).not.toBeInTheDocument();
  });

  it('threads over_caps from the markRequestComplete response into the result dialog', async () => {
    provisionAddOrChangeMock.mockResolvedValue({
      kindoo_uid: 'new-uid',
      action: 'invited',
      note: 'Added Test User to Kindoo with access to Maple Building.',
    });
    markRequestCompleteMock.mockResolvedValue({
      ok: true,
      over_caps: [{ pool: 'stake', count: 351, cap: 350, over_by: 1 }],
    });

    const user = userEvent.setup();
    await renderCard();
    await user.click(screen.getByTestId('sba-add-r1'));

    await waitFor(() => expect(screen.getByTestId('sba-result-dialog')).toBeInTheDocument());
    const warning = screen.getByTestId('sba-result-overcap');
    expect(warning).toHaveTextContent(/Stake-wide: 351 \/ 350 \(\+1\)/);
  });

  // ---- Kindoo Sites Phase 3 — orchestrator-entry EID enforcement ----

  /**
   * Helper: build a bundle with a foreign Kindoo site + a ward
   * pointing at it. The `kindooSites` entry may carry a recorded EID
   * or leave it absent (auto-populate path).
   */
  function bundleWithForeignWard(opts: { withEid: boolean }): StakeConfigBundle {
    const base = bundle();
    return {
      ...base,
      // A ward's site derives from its building; Pine Building → 'east-stake'.
      buildings: [
        ...base.buildings,
        {
          building_id: 'pine',
          building_name: 'Pine Building',
          kindoo_site_id: 'east-stake',
          kindoo_rule: { rule_id: 6249, rule_name: 'Pine Doors' },
        } as unknown as StakeConfigBundle['buildings'][number],
      ],
      wards: [
        {
          ward_code: 'FN',
          ward_name: 'Foreign Ward',
          building_name: 'Pine Building',
        } as unknown as StakeConfigBundle['wards'][number],
      ],
      kindooSites: [
        {
          id: 'east-stake',
          display_name: 'East Stake (Pine)',
          kindoo_expected_site_name: 'East Stake',
          ...(opts.withEid ? { kindoo_eid: 4321 } : {}),
        } as unknown as StakeConfigBundle['kindooSites'][number],
      ],
    };
  }

  async function renderCardWithBundle(request: AccessRequest, customBundle: StakeConfigBundle) {
    const { RequestCard } = await import('./RequestCard');
    return render(
      <RequestCard
        stakeId="csnorth"
        request={request}
        bundle={customBundle}
        memberHasSeat={false}
        memberHasStakeGrant={false}
        memberSeatAbsent={false}
        onDismissed={vi.fn()}
      />,
    );
  }

  it('refuses with the foreign site display_name before any Kindoo write on EID mismatch (add path)', async () => {
    // Active session = home (27994); request = foreign ward; foreign
    // site has a recorded EID (4321). Refuse must fire before
    // provisionAddOrChange touches anything.
    const user = userEvent.setup();
    await renderCardWithBundle(
      addRequest({ scope: 'FN' }),
      bundleWithForeignWard({ withEid: true }),
    );
    await user.click(screen.getByTestId('sba-add-r1'));

    await waitFor(() =>
      // Operator-facing message uses display_name ("East Stake (Pine)"),
      // not the slug ("east-stake") or the internal matching key ("East Stake").
      expect(screen.getByTestId('sba-provision-error-r1')).toHaveTextContent("'East Stake (Pine)'"),
    );
    expect(screen.getByTestId('sba-provision-error-r1')).toHaveTextContent(
      /Switch Kindoo sites and try again/,
    );
    expect(provisionAddOrChangeMock).not.toHaveBeenCalled();
    expect(provisionRemoveMock).not.toHaveBeenCalled();
    expect(provisionEditMock).not.toHaveBeenCalled();
    expect(writeKindooSiteEidMock).not.toHaveBeenCalled();
    expect(markRequestCompleteMock).not.toHaveBeenCalled();
  });

  it('refuses on EID mismatch on the edit path too (shared site-check entry guard)', async () => {
    // Mirror the add-path foreign-mismatch scenario but with an
    // edit_manual request type. The site check sits in front of all
    // three provision dispatches (add / edit / remove) at a single
    // shared call site in RequestCard.provision — this test proves the
    // gate runs on the edit path so the shared call site isn't
    // covered only by inspection.
    const user = userEvent.setup();
    await renderCardWithBundle(
      addRequest({ request_id: 'r-edit', type: 'edit_manual', scope: 'FN' }),
      bundleWithForeignWard({ withEid: true }),
    );
    await user.click(screen.getByTestId('sba-edit-r-edit'));

    await waitFor(() =>
      expect(screen.getByTestId('sba-provision-error-r-edit')).toHaveTextContent(
        "'East Stake (Pine)'",
      ),
    );
    expect(screen.getByTestId('sba-provision-error-r-edit')).toHaveTextContent(
      /Switch Kindoo sites and try again/,
    );
    // No orchestrator side effects fire on a refused site check.
    expect(provisionEditMock).not.toHaveBeenCalled();
    expect(provisionAddOrChangeMock).not.toHaveBeenCalled();
    expect(provisionRemoveMock).not.toHaveBeenCalled();
    expect(writeKindooSiteEidMock).not.toHaveBeenCalled();
    expect(markRequestCompleteMock).not.toHaveBeenCalled();
  });

  it('refuses on EID mismatch on the remove path too (shared site-check entry guard)', async () => {
    // Mirror the add-path foreign-mismatch scenario but with a remove
    // request type. The site check sits in front of all three provision
    // dispatches (add / edit / remove) at a single shared call site in
    // RequestCard.provision — this test proves the gate runs on the
    // remove path so the shared call site isn't covered only by
    // inspection.
    const user = userEvent.setup();
    await renderCardWithBundle(
      removeReq({ request_id: 'r-remove', scope: 'FN' }),
      bundleWithForeignWard({ withEid: true }),
    );
    await user.click(screen.getByTestId('sba-remove-r-remove'));

    await waitFor(() =>
      expect(screen.getByTestId('sba-provision-error-r-remove')).toHaveTextContent(
        "'East Stake (Pine)'",
      ),
    );
    expect(screen.getByTestId('sba-provision-error-r-remove')).toHaveTextContent(
      /Switch Kindoo sites and try again/,
    );
    // No orchestrator side effects fire on a refused site check.
    expect(provisionRemoveMock).not.toHaveBeenCalled();
    expect(provisionAddOrChangeMock).not.toHaveBeenCalled();
    expect(provisionEditMock).not.toHaveBeenCalled();
    expect(writeKindooSiteEidMock).not.toHaveBeenCalled();
    expect(markRequestCompleteMock).not.toHaveBeenCalled();
  });

  it('auto-populates kindoo_eid then proceeds when foreign site has no EID and session name matches', async () => {
    // Active session is on the FOREIGN env (EID 4321), name "East Stake".
    // Foreign site has no recorded kindoo_eid. The site check populates
    // the EID via writeKindooSiteEid, THEN the orchestrator runs.
    readKindooSessionMock.mockReturnValue({ ok: true, session: { token: 'tok', eid: 4321 } });
    getEnvironmentsMock.mockResolvedValue([
      { EID: 4321, Name: 'East Stake', TimeZone: 'Mountain Standard Time' },
    ]);
    writeKindooSiteEidMock.mockResolvedValue(undefined);
    provisionAddOrChangeMock.mockResolvedValue({
      kindoo_uid: 'new-uid',
      action: 'invited',
      note: 'Invited Test User.',
    });
    markRequestCompleteMock.mockResolvedValue({ ok: true });

    const user = userEvent.setup();
    await renderCardWithBundle(
      addRequest({ scope: 'FN' }),
      bundleWithForeignWard({ withEid: false }),
    );
    await user.click(screen.getByTestId('sba-add-r1'));

    await waitFor(() => expect(writeKindooSiteEidMock).toHaveBeenCalledTimes(1));
    expect(writeKindooSiteEidMock).toHaveBeenCalledWith('csnorth', 'east-stake', 4321);

    // Persist must complete BEFORE the orchestrator runs — verify by
    // call order via `mock.invocationCallOrder`.
    await waitFor(() => expect(provisionAddOrChangeMock).toHaveBeenCalledTimes(1));
    const writeOrder = writeKindooSiteEidMock.mock.invocationCallOrder[0]!;
    const provisionOrder = provisionAddOrChangeMock.mock.invocationCallOrder[0]!;
    expect(writeOrder).toBeLessThan(provisionOrder);
  });

  it('refuses when foreign site has no EID and active session name does not match', async () => {
    // Active session is on HOME (27994), name "Colorado Springs North
    // Stake". Foreign site expects "East Stake" — name mismatch ⇒
    // refuse, no auto-populate, no Kindoo writes.
    const user = userEvent.setup();
    await renderCardWithBundle(
      addRequest({ scope: 'FN' }),
      bundleWithForeignWard({ withEid: false }),
    );
    await user.click(screen.getByTestId('sba-add-r1'));

    await waitFor(() =>
      expect(screen.getByTestId('sba-provision-error-r1')).toHaveTextContent(/East Stake/),
    );
    expect(writeKindooSiteEidMock).not.toHaveBeenCalled();
    expect(provisionAddOrChangeMock).not.toHaveBeenCalled();
  });

  it("proceeds without populate when the ward's building resolves to home and session is on home", async () => {
    // Ward-scope request on a home-site ward (its building has no
    // kindoo_site_id) — active session is home → ok=true, no populate.
    const base = bundle();
    const customBundle: StakeConfigBundle = {
      ...base,
      wards: [
        {
          ward_code: 'CO',
          ward_name: 'Maple Ward',
          building_name: 'Maple Building',
        } as unknown as StakeConfigBundle['wards'][number],
      ],
    };
    provisionAddOrChangeMock.mockResolvedValue({
      kindoo_uid: 'new-uid',
      action: 'invited',
      note: 'Invited.',
    });
    markRequestCompleteMock.mockResolvedValue({ ok: true });

    const user = userEvent.setup();
    await renderCardWithBundle(addRequest({ scope: 'CO' }), customBundle);
    await user.click(screen.getByTestId('sba-add-r1'));

    await waitFor(() => expect(provisionAddOrChangeMock).toHaveBeenCalledTimes(1));
    expect(writeKindooSiteEidMock).not.toHaveBeenCalled();
  });

  it('dismiss calls onDismissed with the request id', async () => {
    provisionAddOrChangeMock.mockResolvedValue({
      kindoo_uid: 'new-uid',
      action: 'invited',
      note: 'Added.',
    });
    markRequestCompleteMock.mockResolvedValue({ ok: true });
    const onDismissed = vi.fn();

    const user = userEvent.setup();
    await renderCard({ onDismissed });
    await user.click(screen.getByTestId('sba-add-r1'));

    await waitFor(() => expect(screen.getByTestId('sba-result-dismiss')).toBeInTheDocument());
    await user.click(screen.getByTestId('sba-result-dismiss'));

    expect(onDismissed).toHaveBeenCalledWith('r1');
  });

  // ---- Reject (every card) ------------------------------------------

  it('renders a Reject button on every card alongside the provision button', async () => {
    await renderCard();
    expect(screen.getByTestId('sba-add-r1')).toBeInTheDocument();
    expect(screen.getByTestId('sba-reject-r1')).toBeInTheDocument();
  });

  it('also renders a Reject button on remove cards', async () => {
    await renderCard({ request: removeReq() });
    expect(screen.getByTestId('sba-remove-r2')).toBeInTheDocument();
    expect(screen.getByTestId('sba-reject-r2')).toBeInTheDocument();
  });

  it('opens the reject dialog with confirm disabled until a reason is typed', async () => {
    const user = userEvent.setup();
    await renderCard();
    await user.click(screen.getByTestId('sba-reject-r1'));

    expect(screen.getByTestId('sba-reject-dialog-r1')).toBeInTheDocument();
    expect(screen.getByTestId('sba-reject-confirm-r1')).toBeDisabled();

    await user.type(screen.getByTestId('sba-reject-reason-r1'), 'Wrong building');
    expect(screen.getByTestId('sba-reject-confirm-r1')).toBeEnabled();
  });

  it('shows the ward NAME in the reject dialog summary when wards resolve', async () => {
    const user = userEvent.setup();
    await renderCard({ request: addRequest({ scope: 'CO' }), bundle: bundleWithWards() });
    await user.click(screen.getByTestId('sba-reject-r1'));

    const summary = screen.getByTestId('sba-reject-summary');
    expect(summary).toHaveTextContent('in Maple Ward');
    expect(summary).not.toHaveTextContent('in CO');
  });

  it('falls back to the raw scope code in the reject dialog summary when wards are empty', async () => {
    const user = userEvent.setup();
    // Default bundle() ships `wards: []`.
    await renderCard({ request: addRequest({ scope: 'CO' }) });
    await user.click(screen.getByTestId('sba-reject-r1'));

    expect(screen.getByTestId('sba-reject-summary')).toHaveTextContent('in CO');
  });

  it('keeps confirm disabled when the reason is only whitespace', async () => {
    const user = userEvent.setup();
    await renderCard();
    await user.click(screen.getByTestId('sba-reject-r1'));
    await user.type(screen.getByTestId('sba-reject-reason-r1'), '   ');
    expect(screen.getByTestId('sba-reject-confirm-r1')).toBeDisabled();
    expect(rejectRequestMock).not.toHaveBeenCalled();
  });

  it('rejects with the trimmed reason and calls onDismissed on success', async () => {
    rejectRequestMock.mockResolvedValue(undefined);
    const onDismissed = vi.fn();

    const user = userEvent.setup();
    await renderCard({ onDismissed });
    await user.click(screen.getByTestId('sba-reject-r1'));
    await user.type(screen.getByTestId('sba-reject-reason-r1'), '  Not eligible  ');
    await user.click(screen.getByTestId('sba-reject-confirm-r1'));

    await waitFor(() => expect(rejectRequestMock).toHaveBeenCalledTimes(1));
    expect(rejectRequestMock).toHaveBeenCalledWith('csnorth', 'r1', 'Not eligible');
    expect(onDismissed).toHaveBeenCalledWith('r1');
    // Provision flow must not run on a reject.
    expect(provisionAddOrChangeMock).not.toHaveBeenCalled();
    expect(markRequestCompleteMock).not.toHaveBeenCalled();
  });

  it('surfaces a reject error inline and keeps the dialog open without dismissing or refetching', async () => {
    // On failure the error must PERSIST so the operator can read it.
    // `onDismissed` is the single trigger for both card-drop and the
    // queue refetch (QueuePanel.handleDismissed), so asserting it is
    // never called proves neither happens on the failure path.
    rejectRequestMock.mockRejectedValue(
      new Error('Request is no longer pending (current status: complete).'),
    );
    const onDismissed = vi.fn();

    const user = userEvent.setup();
    await renderCard({ onDismissed });
    await user.click(screen.getByTestId('sba-reject-r1'));
    await user.type(screen.getByTestId('sba-reject-reason-r1'), 'Duplicate');
    await user.click(screen.getByTestId('sba-reject-confirm-r1'));

    await waitFor(() =>
      expect(screen.getByTestId('sba-reject-error-r1')).toHaveTextContent(/no longer pending/),
    );
    expect(onDismissed).not.toHaveBeenCalled();
    // Dialog stays mounted with the error still visible (nothing
    // unmounts it or auto-clears the alert) and the confirm button
    // re-enables for a retry.
    expect(screen.getByTestId('sba-reject-dialog-r1')).toBeInTheDocument();
    expect(screen.getByTestId('sba-reject-error-r1')).toBeInTheDocument();
    expect(screen.getByTestId('sba-reject-confirm-r1')).toBeEnabled();
  });

  // ---- Add for an existing user → Reject-only -----------------------

  it('hides the provision button and shows the existing-seat notice for a temp add when memberHasSeat', async () => {
    // add_temp is never carved out — always Reject-only on an existing
    // seat, regardless of stake-grant state.
    await renderCard({ request: addRequest({ type: 'add_temp' }), memberHasSeat: true });
    expect(screen.queryByTestId('sba-add-r1')).not.toBeInTheDocument();
    expect(screen.getByTestId('sba-existing-seat-r1')).toHaveTextContent(
      /Member already has a seat/,
    );
    // Reject is still available.
    expect(screen.getByTestId('sba-reject-r1')).toBeInTheDocument();
  });

  it('hides the provision button for a ward-scope manual add when memberHasSeat', async () => {
    // Carve-out is stake-scope only; a ward-scope add_manual on an
    // existing seat stays Reject-only.
    await renderCard({ request: addRequest({ scope: 'CO' }), memberHasSeat: true });
    expect(screen.queryByTestId('sba-add-r1')).not.toBeInTheDocument();
    expect(screen.getByTestId('sba-existing-seat-r1')).toBeInTheDocument();
    expect(screen.getByTestId('sba-reject-r1')).toBeInTheDocument();
  });

  it('still shows the provision button for remove type even when memberHasSeat', async () => {
    await renderCard({ request: removeReq(), memberHasSeat: true });
    expect(screen.getByTestId('sba-remove-r2')).toBeInTheDocument();
    expect(screen.queryByTestId('sba-existing-seat-r2')).not.toBeInTheDocument();
    expect(screen.getByTestId('sba-reject-r2')).toBeInTheDocument();
  });

  it('shows the provision button for add type when memberHasSeat is false', async () => {
    await renderCard({ memberHasSeat: false });
    expect(screen.getByTestId('sba-add-r1')).toBeInTheDocument();
    expect(screen.queryByTestId('sba-existing-seat-r1')).not.toBeInTheDocument();
  });

  // ---- Stake-scope add carve-out (Give Access To Stake Buildings) ---

  it('shows the provision button for a stake-scope manual add on an existing seat WITHOUT a stake grant', async () => {
    // The foreign-site-only member always holds a ward seat; the
    // stake-scope add is applyable (planAddMerge appends a cross-scope
    // duplicate grant). Provision button must NOT be blocked.
    await renderCard({
      request: addRequest({ type: 'add_manual', scope: 'stake' }),
      memberHasSeat: true,
      memberHasStakeGrant: false,
    });
    expect(screen.getByTestId('sba-add-r1')).toBeInTheDocument();
    expect(screen.queryByTestId('sba-existing-seat-r1')).not.toBeInTheDocument();
  });

  it('still blocks a stake-scope manual add when the member ALREADY has a stake grant', async () => {
    // Backstop: a stake grant already exists → the add can't apply
    // cleanly, so keep Reject-only.
    await renderCard({
      request: addRequest({ type: 'add_manual', scope: 'stake' }),
      memberHasSeat: true,
      memberHasStakeGrant: true,
    });
    expect(screen.queryByTestId('sba-add-r1')).not.toBeInTheDocument();
    expect(screen.getByTestId('sba-existing-seat-r1')).toBeInTheDocument();
    expect(screen.getByTestId('sba-reject-r1')).toBeInTheDocument();
  });

  // ---- Edit for a nonexistent seat → Reject-only --------------------

  it('hides the provision button and shows the missing-seat notice when memberSeatAbsent (edit type)', async () => {
    await renderCard({ request: editReq(), memberSeatAbsent: true });
    expect(screen.queryByTestId('sba-edit-r3')).not.toBeInTheDocument();
    expect(screen.getByTestId('sba-missing-seat-r3')).toHaveTextContent(
      /edits a seat that no longer exists — reject it/,
    );
    // Reject is still available.
    expect(screen.getByTestId('sba-reject-r3')).toBeInTheDocument();
  });

  it('shows the Update button for edit type when the seat is present (memberSeatAbsent false)', async () => {
    await renderCard({ request: editReq(), memberSeatAbsent: false });
    expect(screen.getByTestId('sba-edit-r3')).toBeInTheDocument();
    expect(screen.queryByTestId('sba-missing-seat-r3')).not.toBeInTheDocument();
  });

  it('fail-safe: shows the Update button for edit type when seat-existence is unknown', async () => {
    // Unknown lookup ⇒ both flags false ⇒ NOT blocked (opposite default
    // from the add gate — we don't false-block an editable request on a
    // transient miss; the server-side planEditSeat is the backstop).
    await renderCard({ request: editReq(), memberHasSeat: false, memberSeatAbsent: false });
    expect(screen.getByTestId('sba-edit-r3')).toBeInTheDocument();
    expect(screen.queryByTestId('sba-missing-seat-r3')).not.toBeInTheDocument();
  });

  it('does not show the missing-seat notice for add type even when memberSeatAbsent (add path is first-time-add)', async () => {
    // An absent seat is the NORMAL case for an add — the edit gate must
    // not fire for add types.
    await renderCard({ memberSeatAbsent: true });
    expect(screen.getByTestId('sba-add-r1')).toBeInTheDocument();
    expect(screen.queryByTestId('sba-missing-seat-r1')).not.toBeInTheDocument();
  });

  it('does not show the missing-seat notice for remove type even when memberSeatAbsent', async () => {
    await renderCard({ request: removeReq(), memberSeatAbsent: true });
    expect(screen.getByTestId('sba-remove-r2')).toBeInTheDocument();
    expect(screen.queryByTestId('sba-missing-seat-r2')).not.toBeInTheDocument();
  });
});
