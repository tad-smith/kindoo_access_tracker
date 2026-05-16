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
const writeKindooSiteEidMock = vi.fn();

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
    writeKindooSiteEid: (...args: unknown[]) => writeKindooSiteEidMock(...args),
  };
});

import type { AccessRequest } from '@kindoo/shared';
import type { StakeConfigBundle } from '../lib/extensionApi';

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
        building_id: 'cordera',
        building_name: 'Cordera Building',
        kindoo_rule: { rule_id: 6248, rule_name: 'Cordera Doors' },
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
    member_name: 'Tad Smith',
    reason: 'Sunday School Teacher',
    comment: '',
    building_names: ['Cordera Building'],
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

async function renderCard(
  opts: { request?: AccessRequest; onDismissed?: (id: string) => void } = {},
) {
  const { RequestCard } = await import('./RequestCard');
  return render(
    <RequestCard
      request={opts.request ?? addRequest()}
      bundle={bundle()}
      onDismissed={opts.onDismissed ?? vi.fn()}
    />,
  );
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
    writeKindooSiteEidMock.mockReset();
    readKindooSessionMock.mockReturnValue({ ok: true, session: { token: 'tok', eid: 27994 } });
    getEnvironmentsMock.mockResolvedValue([
      { EID: 27994, Name: 'Colorado Springs North Stake', TimeZone: 'Mountain Standard Time' },
    ]);
    // Default: subject has no SBA seat yet (first-time-add path);
    // individual tests override when they need a populated seat.
    getSeatByEmailMock.mockResolvedValue(null);
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

  it('runs provisionAddOrChange and markRequestComplete on click, then shows the result dialog', async () => {
    provisionAddOrChangeMock.mockResolvedValue({
      kindoo_uid: 'new-uid',
      action: 'invited',
      note: 'Added Tad Smith to Kindoo with access to Cordera Building.',
    });
    markRequestCompleteMock.mockResolvedValue({ ok: true });

    const user = userEvent.setup();
    await renderCard();
    await user.click(screen.getByTestId('sba-add-r1'));

    await waitFor(() => expect(screen.getByTestId('sba-result-dialog')).toBeInTheDocument());
    expect(screen.getByTestId('sba-result-note')).toHaveTextContent(
      'Added Tad Smith to Kindoo with access to Cordera Building.',
    );
    expect(markRequestCompleteMock).toHaveBeenCalledWith({
      stakeId: 'csnorth',
      requestId: 'r1',
      completionNote: 'Added Tad Smith to Kindoo with access to Cordera Building.',
      provisioningNote: 'Added Tad Smith to Kindoo with access to Cordera Building.',
      kindooUid: 'new-uid',
    });
  });

  it('runs provisionRemove (with envs fetch — needed for editUser timezone) for remove-type requests', async () => {
    provisionRemoveMock.mockResolvedValue({
      kindoo_uid: 'removed-uid',
      action: 'removed',
      note: 'Removed Tad Smith from Kindoo.',
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
      note: 'Tad Smith was not in Kindoo (no-op).',
    });
    markRequestCompleteMock.mockResolvedValue({ ok: true });

    const user = userEvent.setup();
    await renderCard({ request: removeReq() });
    await user.click(screen.getByTestId('sba-remove-r2'));

    await waitFor(() => expect(markRequestCompleteMock).toHaveBeenCalledTimes(1));
    const payload = markRequestCompleteMock.mock.calls[0]![0];
    expect(payload.kindooUid).toBeUndefined();
    expect(payload.provisioningNote).toBe('Tad Smith was not in Kindoo (no-op).');
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
      note: 'Added Tad Smith to Kindoo with access to Cordera Building.',
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
      note: 'Added Tad Smith to Kindoo with access to Cordera Building.',
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
      note: 'Added Tad Smith to Kindoo with access to Cordera Building.',
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
      wards: [
        {
          ward_code: 'FN',
          ward_name: 'Foreign Ward',
          building_name: 'Foothills Building',
          kindoo_site_id: 'east-stake',
        } as unknown as StakeConfigBundle['wards'][number],
      ],
      kindooSites: [
        {
          id: 'east-stake',
          display_name: 'East Stake (Foothills)',
          kindoo_expected_site_name: 'East Stake',
          ...(opts.withEid ? { kindoo_eid: 4321 } : {}),
        } as unknown as StakeConfigBundle['kindooSites'][number],
      ],
    };
  }

  async function renderCardWithBundle(request: AccessRequest, customBundle: StakeConfigBundle) {
    const { RequestCard } = await import('./RequestCard');
    return render(<RequestCard request={request} bundle={customBundle} onDismissed={vi.fn()} />);
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
      // Operator-facing message uses display_name ("East Stake (Foothills)"),
      // not the slug ("east-stake") or the internal matching key ("East Stake").
      expect(screen.getByTestId('sba-provision-error-r1')).toHaveTextContent(
        "'East Stake (Foothills)'",
      ),
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
        "'East Stake (Foothills)'",
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
      note: 'Invited Tad Smith.',
    });
    markRequestCompleteMock.mockResolvedValue({ ok: true });

    const user = userEvent.setup();
    await renderCardWithBundle(
      addRequest({ scope: 'FN' }),
      bundleWithForeignWard({ withEid: false }),
    );
    await user.click(screen.getByTestId('sba-add-r1'));

    await waitFor(() => expect(writeKindooSiteEidMock).toHaveBeenCalledTimes(1));
    expect(writeKindooSiteEidMock).toHaveBeenCalledWith('east-stake', 4321);

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

  it('proceeds without populate when ward has no kindoo_site_id and session is on home', async () => {
    // Ward-scope request on a home-site ward (kindoo_site_id absent) —
    // active session is home → check returns ok=true, no populate.
    const base = bundle();
    const customBundle: StakeConfigBundle = {
      ...base,
      wards: [
        {
          ward_code: 'CO',
          ward_name: 'Cordera Ward',
          building_name: 'Cordera Building',
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
});
