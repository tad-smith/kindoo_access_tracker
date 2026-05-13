// Orchestration tests for the v2.2 Provision & Complete flow.
//
// Mocks the five write endpoints (`checkUserType`, `inviteUser`,
// `saveAccessRule`, `lookupUserByEmail`, `revokeUser`) at the module
// boundary; we don't care about wire-format details here — those are
// covered in endpoints.test.ts. We DO care about which endpoints are
// called, in which order, with which derived payloads.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const checkUserTypeMock = vi.fn();
const inviteUserMock = vi.fn();
const saveAccessRuleMock = vi.fn();
const lookupUserByEmailMock = vi.fn();
const revokeUserMock = vi.fn();

vi.mock('./endpoints', async () => {
  const actual = await vi.importActual<typeof import('./endpoints')>('./endpoints');
  return {
    ...actual,
    checkUserType: (...args: unknown[]) => checkUserTypeMock(...args),
    inviteUser: (...args: unknown[]) => inviteUserMock(...args),
    saveAccessRule: (...args: unknown[]) => saveAccessRuleMock(...args),
    lookupUserByEmail: (...args: unknown[]) => lookupUserByEmailMock(...args),
    revokeUser: (...args: unknown[]) => revokeUserMock(...args),
  };
});

import type { AccessRequest, Building, Stake, Ward } from '@kindoo/shared';
import {
  provisionAddOrChange,
  provisionRemove,
  ProvisionBuildingsMissingRuleError,
  ProvisionEnvironmentNotFoundError,
} from './provision';
import type { KindooEnvironment } from './endpoints';

const SESSION = { token: 'tok', eid: 27994 };

const STAKE: Stake = {
  stake_id: 'csnorth',
  stake_name: 'Colorado Springs North Stake',
} as unknown as Stake;

const BUILDINGS: Building[] = [
  {
    building_id: 'cordera',
    building_name: 'Cordera Building',
    kindoo_rule: { rule_id: 6248, rule_name: 'Cordera Doors' },
  } as unknown as Building,
  {
    building_id: 'pine-creek',
    building_name: 'Pine Creek Building',
    kindoo_rule: { rule_id: 6249, rule_name: 'Pine Creek Doors' },
  } as unknown as Building,
  {
    building_id: 'monument',
    building_name: 'Monument Building',
    // No kindoo_rule — used to exercise the missing-mapping path.
  } as unknown as Building,
];

const WARDS: Ward[] = [
  {
    ward_code: 'CO',
    ward_name: 'Cordera Ward',
    building_name: 'Cordera Building',
  } as unknown as Ward,
  {
    ward_code: 'PC',
    ward_name: 'Pine Creek Ward',
    building_name: 'Pine Creek Building',
  } as unknown as Ward,
];

const ENVS: KindooEnvironment[] = [
  {
    EID: 27994,
    Name: 'Colorado Springs North Stake',
    TimeZone: 'Mountain Standard Time',
  } as unknown as KindooEnvironment,
];

function addManualRequest(overrides: Partial<AccessRequest> = {}): AccessRequest {
  return {
    request_id: 'r1',
    type: 'add_manual',
    scope: 'stake',
    member_email: 'tad.e.smith@gmail.com',
    member_canonical: 'tad.e.smith@gmail.com',
    member_name: 'Tad Smith',
    reason: 'Sunday School Teacher',
    comment: '',
    building_names: ['Cordera Building', 'Pine Creek Building'],
    status: 'pending',
    requester_email: 'requester@example.com',
    requester_canonical: 'requester@example.com',
    requested_at: { seconds: 1, nanoseconds: 0 } as unknown as AccessRequest['requested_at'],
    lastActor: { email: 'r@x', canonical: 'r@x' },
    ...overrides,
  } as AccessRequest;
}

function addTempRequest(overrides: Partial<AccessRequest> = {}): AccessRequest {
  return addManualRequest({
    type: 'add_temp',
    start_date: '2026-05-13',
    end_date: '2026-05-14',
    ...overrides,
  });
}

function removeRequest(overrides: Partial<AccessRequest> = {}): AccessRequest {
  return addManualRequest({
    type: 'remove',
    reason: '',
    member_name: 'Tad Smith',
    ...overrides,
  });
}

beforeEach(() => {
  checkUserTypeMock.mockReset();
  inviteUserMock.mockReset();
  saveAccessRuleMock.mockReset();
  lookupUserByEmailMock.mockReset();
  revokeUserMock.mockReset();
});
afterEach(() => {
  vi.resetModules();
});

describe('provisionAddOrChange — add_manual', () => {
  it('invites a new user, then saves the access rule, returning action="added"', async () => {
    checkUserTypeMock.mockResolvedValue({ exists: false, uid: null });
    inviteUserMock.mockResolvedValue({ uid: 'new-uid' });
    saveAccessRuleMock.mockResolvedValue({ ok: true });

    const result = await provisionAddOrChange({
      request: addManualRequest(),
      stake: STAKE,
      buildings: BUILDINGS,
      wards: WARDS,
      envs: ENVS,
      session: SESSION,
    });

    expect(checkUserTypeMock).toHaveBeenCalledWith(SESSION, 'tad.e.smith@gmail.com', undefined);
    expect(inviteUserMock).toHaveBeenCalledTimes(1);
    const invitePayload = inviteUserMock.mock.calls[0]![1];
    expect(invitePayload).toMatchObject({
      UserEmail: 'tad.e.smith@gmail.com',
      UserRole: 2,
      Description: 'Colorado Springs North Stake (Sunday School Teacher)',
      CCInEmail: false,
      IsTempUser: false,
      StartAccessDoorsDate: null,
      ExpiryDate: null,
      ExpiryTimeZone: 'Mountain Standard Time',
    });
    expect(saveAccessRuleMock).toHaveBeenCalledWith(SESSION, 'new-uid', [6248, 6249], undefined);
    expect(result).toEqual({
      kindoo_uid: 'new-uid',
      action: 'added',
      note: 'Added Tad Smith to Kindoo with access to Cordera Building, Pine Creek Building.',
    });
  });

  it('skips inviteUser and updates rules when the user already exists', async () => {
    checkUserTypeMock.mockResolvedValue({ exists: true, uid: 'existing-uid' });
    saveAccessRuleMock.mockResolvedValue({ ok: true });

    const result = await provisionAddOrChange({
      request: addManualRequest({ building_names: ['Cordera Building'] }),
      stake: STAKE,
      buildings: BUILDINGS,
      wards: WARDS,
      envs: ENVS,
      session: SESSION,
    });

    expect(inviteUserMock).not.toHaveBeenCalled();
    expect(saveAccessRuleMock).toHaveBeenCalledWith(SESSION, 'existing-uid', [6248], undefined);
    expect(result).toEqual({
      kindoo_uid: 'existing-uid',
      action: 'updated',
      note: "Updated Tad Smith's Kindoo access to Cordera Building.",
    });
  });

  it('falls back to member_email in the note when member_name is empty', async () => {
    checkUserTypeMock.mockResolvedValue({ exists: false, uid: null });
    inviteUserMock.mockResolvedValue({ uid: 'new-uid' });
    saveAccessRuleMock.mockResolvedValue({ ok: true });

    const result = await provisionAddOrChange({
      request: addManualRequest({ member_name: '', building_names: ['Cordera Building'] }),
      stake: STAKE,
      buildings: BUILDINGS,
      wards: WARDS,
      envs: ENVS,
      session: SESSION,
    });
    expect(result.note).toBe(
      'Added tad.e.smith@gmail.com to Kindoo with access to Cordera Building.',
    );
  });

  it('uses kindoo_expected_site_name as the Description scope when set', async () => {
    checkUserTypeMock.mockResolvedValue({ exists: false, uid: null });
    inviteUserMock.mockResolvedValue({ uid: 'new-uid' });
    saveAccessRuleMock.mockResolvedValue({ ok: true });

    const stakeWithOverride = {
      ...STAKE,
      stake_name: 'STAGING - Colorado Springs North Stake',
      kindoo_expected_site_name: 'Colorado Springs North Stake',
    } as Stake;
    await provisionAddOrChange({
      request: addManualRequest({ building_names: ['Cordera Building'] }),
      stake: stakeWithOverride,
      buildings: BUILDINGS,
      wards: WARDS,
      envs: ENVS,
      session: SESSION,
    });
    const invitePayload = inviteUserMock.mock.calls[0]![1];
    expect(invitePayload.Description).toBe('Colorado Springs North Stake (Sunday School Teacher)');
  });

  it('resolves ward-scope requests to ward_name + ward.building_name', async () => {
    checkUserTypeMock.mockResolvedValue({ exists: false, uid: null });
    inviteUserMock.mockResolvedValue({ uid: 'new-uid' });
    saveAccessRuleMock.mockResolvedValue({ ok: true });

    await provisionAddOrChange({
      request: addManualRequest({ scope: 'CO', building_names: [] }),
      stake: STAKE,
      buildings: BUILDINGS,
      wards: WARDS,
      envs: ENVS,
      session: SESSION,
    });

    const invitePayload = inviteUserMock.mock.calls[0]![1];
    expect(invitePayload.Description).toBe('Cordera Ward (Sunday School Teacher)');
    expect(saveAccessRuleMock).toHaveBeenCalledWith(SESSION, 'new-uid', [6248], undefined);
  });

  it('throws ProvisionBuildingsMissingRuleError when a requested building has no rule_id', async () => {
    await expect(
      provisionAddOrChange({
        request: addManualRequest({ building_names: ['Cordera Building', 'Monument Building'] }),
        stake: STAKE,
        buildings: BUILDINGS,
        wards: WARDS,
        envs: ENVS,
        session: SESSION,
      }),
    ).rejects.toBeInstanceOf(ProvisionBuildingsMissingRuleError);
    // checkUserType is never reached.
    expect(checkUserTypeMock).not.toHaveBeenCalled();
  });

  it('throws ProvisionEnvironmentNotFoundError when no env matches the session EID', async () => {
    await expect(
      provisionAddOrChange({
        request: addManualRequest({ building_names: ['Cordera Building'] }),
        stake: STAKE,
        buildings: BUILDINGS,
        wards: WARDS,
        envs: [],
        session: SESSION,
      }),
    ).rejects.toBeInstanceOf(ProvisionEnvironmentNotFoundError);
  });

  it('rejects with a clear error when called with the wrong request type', async () => {
    await expect(
      provisionAddOrChange({
        request: removeRequest(),
        stake: STAKE,
        buildings: BUILDINGS,
        wards: WARDS,
        envs: ENVS,
        session: SESSION,
      }),
    ).rejects.toThrow(/non-add type/);
  });
});

describe('provisionAddOrChange — add_temp', () => {
  it('builds an IsTempUser=true payload with full-day bounds', async () => {
    checkUserTypeMock.mockResolvedValue({ exists: false, uid: null });
    inviteUserMock.mockResolvedValue({ uid: 'temp-uid' });
    saveAccessRuleMock.mockResolvedValue({ ok: true });

    await provisionAddOrChange({
      request: addTempRequest({
        start_date: '2026-05-13',
        end_date: '2026-05-14',
        building_names: ['Cordera Building'],
      }),
      stake: STAKE,
      buildings: BUILDINGS,
      wards: WARDS,
      envs: ENVS,
      session: SESSION,
    });
    const invitePayload = inviteUserMock.mock.calls[0]![1];
    expect(invitePayload).toMatchObject({
      IsTempUser: true,
      StartAccessDoorsDate: '2026-05-13 00:00',
      ExpiryDate: '2026-05-14 23:59',
      ExpiryTimeZone: 'Mountain Standard Time',
    });
  });

  it('throws unexpected-shape when add_temp is missing start_date or end_date', async () => {
    checkUserTypeMock.mockResolvedValue({ exists: false, uid: null });

    // Build the request and then explicitly drop end_date to simulate
    // an in-the-wild missing field (the type has it optional).
    const req = addTempRequest({
      start_date: '2026-05-13',
      end_date: '2026-05-14',
      building_names: ['Cordera Building'],
    });
    delete (req as { end_date?: string }).end_date;

    await expect(
      provisionAddOrChange({
        request: req,
        stake: STAKE,
        buildings: BUILDINGS,
        wards: WARDS,
        envs: ENVS,
        session: SESSION,
      }),
    ).rejects.toMatchObject({ code: 'unexpected-shape' });
  });
});

describe('provisionRemove', () => {
  it('looks up the user, revokes them, and returns action="removed"', async () => {
    lookupUserByEmailMock.mockResolvedValue({
      users: [{ uid: 'match-uid', email: 'tad.e.smith@gmail.com' }],
    });
    revokeUserMock.mockResolvedValue({ ok: true });

    const result = await provisionRemove({
      request: removeRequest(),
      session: SESSION,
    });

    expect(lookupUserByEmailMock).toHaveBeenCalledWith(SESSION, 'tad.e.smith@gmail.com', undefined);
    expect(revokeUserMock).toHaveBeenCalledWith(SESSION, 'match-uid', undefined);
    expect(result).toEqual({
      kindoo_uid: 'match-uid',
      action: 'removed',
      note: 'Removed Tad Smith from Kindoo.',
    });
  });

  it('returns a noop-remove without calling revokeUser when no match is found', async () => {
    lookupUserByEmailMock.mockResolvedValue({ users: [] });

    const result = await provisionRemove({
      request: removeRequest(),
      session: SESSION,
    });

    expect(revokeUserMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      kindoo_uid: null,
      action: 'noop-remove',
      note: 'Tad Smith was not in Kindoo (no-op).',
    });
  });

  it('falls back to member_email in the note when member_name is empty', async () => {
    lookupUserByEmailMock.mockResolvedValue({ users: [] });

    const result = await provisionRemove({
      request: removeRequest({ member_name: '' }),
      session: SESSION,
    });
    expect(result.note).toBe('tad.e.smith@gmail.com was not in Kindoo (no-op).');
  });

  it('rejects with a clear error when called with the wrong request type', async () => {
    await expect(
      provisionRemove({
        request: addManualRequest(),
        session: SESSION,
      }),
    ).rejects.toThrow(/non-remove type/);
  });
});
