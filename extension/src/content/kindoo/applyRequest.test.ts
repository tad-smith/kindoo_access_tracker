// Unit tests for the shared provisioning orchestration.
//
// `RequestCard.test.tsx` already covers the desktop button end to end
// through this module; these tests pin the discriminated `code` on each
// failure path, because that is what the phone branches on and nothing
// on the desktop would notice if a code were wrong.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const provisionAddOrChangeMock = vi.fn();
const provisionRemoveMock = vi.fn();
const provisionEditMock = vi.fn();
const getEnvironmentsMock = vi.fn();
const readKindooSessionMock = vi.fn();
const markRequestCompleteMock = vi.fn();
const getSeatByEmailMock = vi.fn();
const writeKindooSiteEidMock = vi.fn();

vi.mock('./provision', async () => {
  const actual = await vi.importActual<typeof import('./provision')>('./provision');
  return {
    ...actual,
    provisionAddOrChange: (...args: unknown[]) => provisionAddOrChangeMock(...args),
    provisionRemove: (...args: unknown[]) => provisionRemoveMock(...args),
    provisionEdit: (...args: unknown[]) => provisionEditMock(...args),
  };
});

vi.mock('./endpoints', async () => {
  const actual = await vi.importActual<typeof import('./endpoints')>('./endpoints');
  return {
    ...actual,
    getEnvironments: (...args: unknown[]) => getEnvironmentsMock(...args),
  };
});

vi.mock('./auth', () => ({
  readKindooSession: (...args: unknown[]) => readKindooSessionMock(...args),
}));

vi.mock('../../lib/extensionApi', async () => {
  const actual =
    await vi.importActual<typeof import('../../lib/extensionApi')>('../../lib/extensionApi');
  return {
    ...actual,
    markRequestComplete: (...args: unknown[]) => markRequestCompleteMock(...args),
    getSeatByEmail: (...args: unknown[]) => getSeatByEmailMock(...args),
    writeKindooSiteEid: (...args: unknown[]) => writeKindooSiteEidMock(...args),
  };
});

import type { AccessRequest } from '@kindoo/shared';
import type { StakeConfigBundle } from '../../lib/extensionApi';

const STAKE_ID = 'csnorth';
const HOME_EID = 27994;

function bundle(): StakeConfigBundle {
  return {
    stake: {
      stake_id: STAKE_ID,
      stake_name: 'Colorado Springs North Stake',
      kindoo_config: { site_id: HOME_EID, site_name: 'Colorado Springs North Stake' },
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

/** Bundle with a foreign-site ward whose EID does not match the active
 * (home) session — the site-mismatch fixture. */
function foreignBundle(): StakeConfigBundle {
  const base = bundle();
  return {
    ...base,
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
        kindoo_eid: 4321,
      } as unknown as StakeConfigBundle['kindooSites'][number],
    ],
  };
}

function request(overrides: Partial<AccessRequest> = {}): AccessRequest {
  return {
    request_id: 'r1',
    type: 'add_manual',
    scope: 'stake',
    member_email: 'member@example.com',
    member_canonical: 'member@example.com',
    member_name: 'Test User',
    building_names: ['Maple Building'],
    status: 'pending',
    ...overrides,
  } as AccessRequest;
}

describe('applyRequest', () => {
  beforeEach(() => {
    provisionAddOrChangeMock.mockReset();
    provisionRemoveMock.mockReset();
    provisionEditMock.mockReset();
    getEnvironmentsMock.mockReset();
    readKindooSessionMock.mockReset();
    markRequestCompleteMock.mockReset();
    getSeatByEmailMock.mockReset();
    writeKindooSiteEidMock.mockReset();

    readKindooSessionMock.mockReturnValue({ ok: true, session: { token: 'tok', eid: HOME_EID } });
    getEnvironmentsMock.mockResolvedValue([
      { EID: HOME_EID, Name: 'Colorado Springs North Stake', TimeZone: 'Mountain Standard Time' },
    ]);
    getSeatByEmailMock.mockResolvedValue(null);
  });
  afterEach(() => {
    vi.resetModules();
  });

  it('returns "applied" with the note, uid and over-caps on the happy path', async () => {
    provisionAddOrChangeMock.mockResolvedValue({
      kindoo_uid: 'uid-1',
      action: 'invited',
      note: 'Added Test User to Kindoo with access to Maple Building.',
    });
    markRequestCompleteMock.mockResolvedValue({
      ok: true,
      over_caps: [{ pool: 'stake', count: 351, cap: 350, over_by: 1 }],
    });

    const { applyRequest } = await import('./applyRequest');
    const result = await applyRequest({ stakeId: STAKE_ID, request: request(), bundle: bundle() });

    expect(result).toEqual({
      status: 'applied',
      note: 'Added Test User to Kindoo with access to Maple Building.',
      kindooUid: 'uid-1',
      overCaps: [{ pool: 'stake', count: 351, cap: 350, over_by: 1 }],
    });
  });

  it('returns "partial" with a replayable SBA payload when markRequestComplete fails', async () => {
    provisionAddOrChangeMock.mockResolvedValue({
      kindoo_uid: 'uid-1',
      action: 'invited',
      note: 'Added Test User.',
    });
    markRequestCompleteMock.mockRejectedValue(new Error('SBA down'));

    const { applyRequest } = await import('./applyRequest');
    const result = await applyRequest({ stakeId: STAKE_ID, request: request(), bundle: bundle() });

    expect(result.status).toBe('partial');
    if (result.status !== 'partial') throw new Error('unreachable');
    expect(result.message).toBe('SBA down');
    // The retry payload replays ONLY the SBA half — no Kindoo call.
    expect(result.markCompleteInput).toEqual({
      stakeId: STAKE_ID,
      requestId: 'r1',
      completionNote: 'Added Test User.',
      provisioningNote: 'Added Test User.',
      kindooUid: 'uid-1',
    });
  });

  it.each([
    ['no-token', /Sign into Kindoo first/],
    ['no-eid', /Open a specific Kindoo site/],
  ] as const)('maps a %s session onto kindoo_session_lost', async (error, matcher) => {
    readKindooSessionMock.mockReturnValue({ ok: false, error });

    const { applyRequest } = await import('./applyRequest');
    const result = await applyRequest({ stakeId: STAKE_ID, request: request(), bundle: bundle() });

    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('unreachable');
    expect(result.code).toBe('kindoo_session_lost');
    expect(result.message).toMatch(matcher);
    expect(provisionAddOrChangeMock).not.toHaveBeenCalled();
  });

  it('maps a wrong-site session onto site_mismatch and names BOTH sites', async () => {
    // The phone deliberately does not duplicate this check, so "switch
    // sites" is only actionable if the sentence says which site the
    // desktop is sitting in.
    const { applyRequest } = await import('./applyRequest');
    const result = await applyRequest({
      stakeId: STAKE_ID,
      request: request({ scope: 'FN' }),
      bundle: foreignBundle(),
    });

    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('unreachable');
    expect(result.code).toBe('site_mismatch');
    expect(result.message).toContain("'East Stake (Pine)'");
    expect(result.message).toContain("'Colorado Springs North Stake'");
    expect(result.message).toContain('Switch Kindoo sites and try again');
    // Refused before any Kindoo write.
    expect(provisionAddOrChangeMock).not.toHaveBeenCalled();
    expect(writeKindooSiteEidMock).not.toHaveBeenCalled();
  });

  it('maps an unmapped building onto building_rule_missing', async () => {
    const { ProvisionBuildingsMissingRuleError } = await import('./provision');
    provisionAddOrChangeMock.mockRejectedValue(
      new ProvisionBuildingsMissingRuleError(['Maple Building']),
    );

    const { applyRequest } = await import('./applyRequest');
    const result = await applyRequest({ stakeId: STAKE_ID, request: request(), bundle: bundle() });

    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('unreachable');
    expect(result.code).toBe('building_rule_missing');
    expect(result.message).toMatch(/no Kindoo Access Rule mapped/);
  });

  it('maps anything else onto the generic error code with the Kindoo message', async () => {
    const { KindooApiError } = await import('./client');
    provisionAddOrChangeMock.mockRejectedValue(new KindooApiError('http-error', 'boom', 500));

    const { applyRequest } = await import('./applyRequest');
    const result = await applyRequest({ stakeId: STAKE_ID, request: request(), bundle: bundle() });

    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('unreachable');
    expect(result.code).toBe('error');
    expect(result.message).toContain('Kindoo API error (http-error)');
  });

  it('never marks the request complete when Kindoo refused', async () => {
    provisionAddOrChangeMock.mockRejectedValue(new Error('Kindoo down'));

    const { applyRequest } = await import('./applyRequest');
    await applyRequest({ stakeId: STAKE_ID, request: request(), bundle: bundle() });

    expect(markRequestCompleteMock).not.toHaveBeenCalled();
  });
});
