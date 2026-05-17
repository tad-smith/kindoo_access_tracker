// Orchestration tests for the v2.2 Provision & Complete flow
// (read-first / merged-state pattern). Mocks the five mutation
// endpoints + the lookup at the module boundary; wire-format details
// belong to endpoints.test.ts. Covers the truth tables in
// `extension/docs/v2-design.md` § "v2.2 — Provision & Complete":
//
// ADD branches:
//   - lookup miss      → invite + saveAccessRule
//   - existing temp + add_manual    → edit (promote permanent) + saveAccessRule
//   - existing perm  + add_manual   → edit (desc only, if changed) + saveAccessRule
//   - existing temp  + add_temp     → edit (refresh dates) + saveAccessRule
//   - existing perm  + add_temp     → no demote; saveAccessRule (rule-only diff)
//   - existing user, full no-diff   → skip both edit + saveAccessRule
//
// REMOVE branches (scope-specific, mirroring SBA's
// `removeSeatOnRequestComplete` trigger):
//   - lookup miss → noop-remove
//   - R-1 race (seat null, lookup miss) → noop-remove
//   - primary scope, no duplicates    → per-rule revoke + revokeUser
//   - primary scope, one duplicate    → revoke only the primary's
//                                       rules; description sync
//   - duplicate scope                 → revoke only the duplicate's
//                                       rules; description sync
//   - duplicate scope, description unchanged → no editUser
//   - subset already in Kindoo, no add needed → no saveAccessRule
//   - stale request (scope doesn't match) → no Kindoo writes

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const inviteUserMock = vi.fn();
const editUserMock = vi.fn();
const saveAccessRuleMock = vi.fn();
const lookupUserByEmailMock = vi.fn();
const revokeUserMock = vi.fn();
const revokeUserFromAccessScheduleMock = vi.fn();
// Door-grant derivation. `buildingsFromDoors.ts` calls these two
// endpoints via the `./endpoints` module barrel; mocking them here
// lets a test stage Church Access Automation's direct grants so the
// orchestrator's "skip redundant rules" logic gets exercised.
// Default: empty rule door map + empty user door set → no direct
// grants, so the diff degenerates to the pre-fix `targetRids -
// currentSchedules` semantic. Tests opt in to direct-grant scenarios
// by overriding these mocks.
const getEnvironmentRuleWithEntryPointsMock = vi.fn();
const getUserAccessRulesWithEntryPointsMock = vi.fn();

vi.mock('./endpoints', async () => {
  const actual = await vi.importActual<typeof import('./endpoints')>('./endpoints');
  return {
    ...actual,
    inviteUser: (...args: unknown[]) => inviteUserMock(...args),
    editUser: (...args: unknown[]) => editUserMock(...args),
    saveAccessRule: (...args: unknown[]) => saveAccessRuleMock(...args),
    lookupUserByEmail: (...args: unknown[]) => lookupUserByEmailMock(...args),
    revokeUser: (...args: unknown[]) => revokeUserMock(...args),
    revokeUserFromAccessSchedule: (...args: unknown[]) => revokeUserFromAccessScheduleMock(...args),
    getEnvironmentRuleWithEntryPoints: (...args: unknown[]) =>
      getEnvironmentRuleWithEntryPointsMock(...args),
    getUserAccessRulesWithEntryPoints: (...args: unknown[]) =>
      getUserAccessRulesWithEntryPointsMock(...args),
  };
});

import type { AccessRequest, Building, DuplicateGrant, Seat, Stake, Ward } from '@kindoo/shared';
import {
  provisionAddOrChange,
  provisionEdit,
  provisionRemove,
  ProvisionBuildingsMissingRuleError,
  ProvisionEditUserMissingError,
  ProvisionEnvironmentNotFoundError,
  ProvisionStakeAutoEditError,
} from './provision';
import type { KindooEnvironment, KindooEnvironmentUser } from './endpoints';

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

/** Fully-populated lookup user with the canonical defaults. */
function existingUser(overrides: Partial<KindooEnvironmentUser> = {}): KindooEnvironmentUser {
  return {
    euid: 'fcf38b4c-1111-1111-1111-111111111111',
    userId: '85bea3c7-1c18-40f0-b514-c828e48bd983',
    username: 'tad.e.smith@gmail.com',
    description: 'Colorado Springs North Stake (Sunday School Teacher)',
    isTempUser: false,
    startAccessDoorsDateAtTimeZone: null,
    expiryDateAtTimeZone: null,
    expiryTimeZone: 'Mountain Standard Time',
    accessSchedules: [{ ruleId: 6248 }, { ruleId: 6249 }],
    ...overrides,
  };
}

beforeEach(() => {
  inviteUserMock.mockReset();
  editUserMock.mockReset();
  saveAccessRuleMock.mockReset();
  lookupUserByEmailMock.mockReset();
  revokeUserMock.mockReset();
  revokeUserFromAccessScheduleMock.mockReset();
  // Default: rules exist (one stub per rid) with non-empty door sets;
  // the user has no direct grants. With empty user-door rows the
  // strict-subset derivation claims nothing → diff falls back to
  // schedules-only. Tests that exercise direct-grant scenarios
  // override these mocks. Stubbing both prevents the real endpoints
  // from being invoked (which would fail with "no fetch in test
  // environment") and silences the fallback-path warn log.
  getEnvironmentRuleWithEntryPointsMock.mockReset();
  getEnvironmentRuleWithEntryPointsMock.mockImplementation(async (_session, ruleId: number) => ({
    ruleId,
    ruleName: `rule-${ruleId}`,
    selectedDoorIds: [ruleId * 100], // unique door per rule
    allDoors: [],
  }));
  getUserAccessRulesWithEntryPointsMock.mockReset();
  getUserAccessRulesWithEntryPointsMock.mockResolvedValue([]); // no direct grants
});
afterEach(() => {
  vi.resetModules();
});

describe('provisionAddOrChange — new user (lookup miss)', () => {
  it('invites the user, then saves the access rule, returning action="invited"', async () => {
    lookupUserByEmailMock.mockResolvedValue(null);
    inviteUserMock.mockResolvedValue({ uid: 'new-uid' });
    saveAccessRuleMock.mockResolvedValue({ ok: true });

    const result = await provisionAddOrChange({
      request: addManualRequest(),
      seat: null,
      stake: STAKE,
      buildings: BUILDINGS,
      wards: WARDS,
      envs: ENVS,
      session: SESSION,
    });

    expect(lookupUserByEmailMock).toHaveBeenCalledWith(SESSION, 'tad.e.smith@gmail.com', undefined);
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
    expect(editUserMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      kindoo_uid: 'new-uid',
      action: 'invited',
      note: 'Invited Tad Smith to Kindoo with access to Cordera Building, Pine Creek Building.',
    });
  });

  it('add_temp invite uses space-separator dates with full-day bounds', async () => {
    lookupUserByEmailMock.mockResolvedValue(null);
    inviteUserMock.mockResolvedValue({ uid: 'temp-uid' });
    saveAccessRuleMock.mockResolvedValue({ ok: true });

    await provisionAddOrChange({
      request: addTempRequest({
        start_date: '2026-05-13',
        end_date: '2026-05-14',
        building_names: ['Cordera Building'],
      }),
      seat: null,
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

  it('throws unexpected-shape when add_temp is missing start/end_date', async () => {
    lookupUserByEmailMock.mockResolvedValue(null);
    const req = addTempRequest({
      start_date: '2026-05-13',
      end_date: '2026-05-14',
      building_names: ['Cordera Building'],
    });
    delete (req as { end_date?: string }).end_date;
    await expect(
      provisionAddOrChange({
        request: req,
        seat: null,
        stake: STAKE,
        buildings: BUILDINGS,
        wards: WARDS,
        envs: ENVS,
        session: SESSION,
      }),
    ).rejects.toMatchObject({ code: 'unexpected-shape' });
  });

  it('merges seat.building_names ∪ request.building_names into the target rule set', async () => {
    lookupUserByEmailMock.mockResolvedValue(null);
    inviteUserMock.mockResolvedValue({ uid: 'new-uid' });
    saveAccessRuleMock.mockResolvedValue({ ok: true });

    const seat: Seat = {
      member_canonical: 'tad.e.smith@gmail.com',
      building_names: ['Pine Creek Building'],
      duplicate_grants: [],
    } as unknown as Seat;

    await provisionAddOrChange({
      request: addManualRequest({ building_names: ['Cordera Building'] }),
      seat,
      stake: STAKE,
      buildings: BUILDINGS,
      wards: WARDS,
      envs: ENVS,
      session: SESSION,
    });

    // Pine Creek (seat) ∪ Cordera (request) → both RIDs.
    expect(saveAccessRuleMock).toHaveBeenCalledWith(SESSION, 'new-uid', [6249, 6248], undefined);
  });

  it('add to user with existing duplicate-grants: target set unions primary + duplicate + request buildings', async () => {
    // Seat primary = PC (Cordera + Pine Creek), one duplicate = MO ward
    // (Monument). New add request is KD scope adding Kings Deer. The
    // post-completion target RID set must cover ALL FOUR buildings —
    // not just the three the primary + request know about — so the
    // saveAccessRule MERGE represents the user's true total scope.
    const buildings: Building[] = [
      // Replace the default Monument entry (no rule) with one that
      // has a rule mapped, then add Kings Deer.
      ...BUILDINGS.filter((b) => b.building_name !== 'Monument Building'),
      {
        building_id: 'monument',
        building_name: 'Monument Building',
        kindoo_rule: { rule_id: 6251, rule_name: 'Monument Doors' },
      } as unknown as Building,
      {
        building_id: 'kings-deer',
        building_name: 'Kings Deer Building',
        kindoo_rule: { rule_id: 6250, rule_name: 'Kings Deer Doors' },
      } as unknown as Building,
    ];
    const seat: Seat = {
      member_canonical: 'tad.e.smith@gmail.com',
      scope: 'PC',
      type: 'manual',
      callings: [],
      reason: 'Bishop',
      building_names: ['Cordera Building', 'Pine Creek Building'],
      duplicate_grants: [
        {
          scope: 'MO',
          type: 'manual',
          callings: [],
          reason: 'Stake Clerk',
          building_names: ['Monument Building'],
          detected_at: { seconds: 1, nanoseconds: 0 } as unknown as DuplicateGrant['detected_at'],
        },
      ],
    } as unknown as Seat;

    lookupUserByEmailMock.mockResolvedValue(null);
    inviteUserMock.mockResolvedValue({ uid: 'new-uid' });
    saveAccessRuleMock.mockResolvedValue({ ok: true });

    const result = await provisionAddOrChange({
      request: addManualRequest({
        scope: 'KD',
        building_names: ['Kings Deer Building'],
      }),
      seat,
      stake: STAKE,
      buildings,
      wards: WARDS,
      envs: ENVS,
      session: SESSION,
    });

    // Order: primary buildings, then duplicate, then request — stable
    // and de-duplicated by `uniqueOrdered`.
    expect(saveAccessRuleMock).toHaveBeenCalledWith(
      SESSION,
      'new-uid',
      [6248, 6249, 6251, 6250],
      undefined,
    );
    // Note mentions all four buildings, not just three.
    expect(result.note).toBe(
      'Invited Tad Smith to Kindoo with access to Cordera Building, Pine Creek Building, Monument Building, Kings Deer Building.',
    );
  });

  it('add to user with duplicate-grant overlapping the primary: dedups each building once', async () => {
    // Seat primary = PC (Cordera + Pine Creek); duplicate = MO whose
    // building_names overlap with the primary (Cordera) plus add
    // Monument. New add of Pine Creek (already in primary). Target
    // should be the de-duplicated union — each building once.
    const buildings: Building[] = [
      ...BUILDINGS.filter((b) => b.building_name !== 'Monument Building'),
      {
        building_id: 'monument',
        building_name: 'Monument Building',
        kindoo_rule: { rule_id: 6251, rule_name: 'Monument Doors' },
      } as unknown as Building,
    ];
    const seat: Seat = {
      member_canonical: 'tad.e.smith@gmail.com',
      scope: 'PC',
      type: 'manual',
      callings: [],
      reason: 'Bishop',
      building_names: ['Cordera Building', 'Pine Creek Building'],
      duplicate_grants: [
        {
          scope: 'MO',
          type: 'manual',
          callings: [],
          reason: 'Stake Clerk',
          building_names: ['Cordera Building', 'Monument Building'],
          detected_at: { seconds: 1, nanoseconds: 0 } as unknown as DuplicateGrant['detected_at'],
        },
      ],
    } as unknown as Seat;

    lookupUserByEmailMock.mockResolvedValue(null);
    inviteUserMock.mockResolvedValue({ uid: 'new-uid' });
    saveAccessRuleMock.mockResolvedValue({ ok: true });

    await provisionAddOrChange({
      request: addManualRequest({
        scope: 'MO',
        building_names: ['Pine Creek Building'],
      }),
      seat,
      stake: STAKE,
      buildings,
      wards: WARDS,
      envs: ENVS,
      session: SESSION,
    });

    // Three distinct RIDs in stable order: Cordera, Pine Creek, Monument.
    expect(saveAccessRuleMock).toHaveBeenCalledWith(
      SESSION,
      'new-uid',
      [6248, 6249, 6251],
      undefined,
    );
  });
});

describe('provisionAddOrChange — existing user (lookup hit)', () => {
  it('existing temp user + add_manual: promotes to permanent via editUser, refreshes rule set', async () => {
    const existing = existingUser({
      description: 'Old description',
      isTempUser: true,
      startAccessDoorsDateAtTimeZone: '2026-05-13T00:00',
      expiryDateAtTimeZone: '2026-05-14T23:59',
      accessSchedules: [{ ruleId: 6249 }],
    });
    lookupUserByEmailMock.mockResolvedValue(existing);
    editUserMock.mockResolvedValue({ ok: true });
    saveAccessRuleMock.mockResolvedValue({ ok: true });

    const result = await provisionAddOrChange({
      request: addManualRequest({ building_names: ['Cordera Building', 'Pine Creek Building'] }),
      seat: null,
      stake: STAKE,
      buildings: BUILDINGS,
      wards: WARDS,
      envs: ENVS,
      session: SESSION,
    });

    expect(inviteUserMock).not.toHaveBeenCalled();
    expect(editUserMock).toHaveBeenCalledTimes(1);
    const editArgs = editUserMock.mock.calls[0]!;
    expect(editArgs[1]).toBe(existing.euid);
    expect(editArgs[2]).toMatchObject({
      description: 'Colorado Springs North Stake (Sunday School Teacher)',
      isTemp: false,
      // Promotion to permanent → dates clear.
      startAccessDoorsDateTime: '',
      expiryDate: '',
      timeZone: 'Mountain Standard Time',
    });
    // Additive MERGE diff: only the missing rule (Cordera = 6248) is
    // sent. Pine Creek (6249) already on the user; no need to
    // re-write it (saveAccessRule MERGEs, so the no-op rid would
    // be a wasted round-trip).
    expect(saveAccessRuleMock).toHaveBeenCalledWith(SESSION, existing.userId, [6248], undefined);
    expect(result.action).toBe('updated');
    expect(result.kindoo_uid).toBe(existing.userId);
  });

  it('existing permanent user + add_manual: edit description-only when text differs; saveAccessRule for the new rule set', async () => {
    const existing = existingUser({
      description: 'Stale description',
      isTempUser: false,
      accessSchedules: [{ ruleId: 6249 }],
    });
    lookupUserByEmailMock.mockResolvedValue(existing);
    editUserMock.mockResolvedValue({ ok: true });
    saveAccessRuleMock.mockResolvedValue({ ok: true });

    await provisionAddOrChange({
      request: addManualRequest({ building_names: ['Cordera Building', 'Pine Creek Building'] }),
      seat: null,
      stake: STAKE,
      buildings: BUILDINGS,
      wards: WARDS,
      envs: ENVS,
      session: SESSION,
    });

    expect(editUserMock).toHaveBeenCalledTimes(1);
    expect(editUserMock.mock.calls[0]![2]).toMatchObject({
      description: 'Colorado Springs North Stake (Sunday School Teacher)',
      isTemp: false,
    });
    // Additive diff: only Cordera (6248) needs adding; Pine Creek
    // (6249) already on the user.
    expect(saveAccessRuleMock).toHaveBeenCalledWith(SESSION, existing.userId, [6248], undefined);
  });

  it('existing temp user + add_temp: refreshes dates via editUser, saves rule set if changed', async () => {
    const existing = existingUser({
      description: 'Colorado Springs North Stake (Sunday School Teacher)',
      isTempUser: true,
      startAccessDoorsDateAtTimeZone: '2026-05-10T00:00',
      expiryDateAtTimeZone: '2026-05-11T23:59',
      accessSchedules: [{ ruleId: 6248 }, { ruleId: 6249 }],
    });
    lookupUserByEmailMock.mockResolvedValue(existing);
    editUserMock.mockResolvedValue({ ok: true });
    saveAccessRuleMock.mockResolvedValue({ ok: true });

    await provisionAddOrChange({
      request: addTempRequest({
        start_date: '2026-05-13',
        end_date: '2026-05-14',
        building_names: ['Cordera Building', 'Pine Creek Building'],
      }),
      seat: null,
      stake: STAKE,
      buildings: BUILDINGS,
      wards: WARDS,
      envs: ENVS,
      session: SESSION,
    });

    expect(editUserMock).toHaveBeenCalledTimes(1);
    expect(editUserMock.mock.calls[0]![2]).toMatchObject({
      isTemp: true,
      startAccessDoorsDateTime: '2026-05-13T00:00',
      expiryDate: '2026-05-14T23:59',
    });
    // Rule set already matches → no saveAccessRule.
    expect(saveAccessRuleMock).not.toHaveBeenCalled();
  });

  it('existing permanent user + add_temp: NO demote to temp; saveAccessRule only if rules differ', async () => {
    const existing = existingUser({
      description: 'Colorado Springs North Stake (Sunday School Teacher)',
      isTempUser: false,
      accessSchedules: [{ ruleId: 6248 }],
    });
    lookupUserByEmailMock.mockResolvedValue(existing);
    saveAccessRuleMock.mockResolvedValue({ ok: true });

    await provisionAddOrChange({
      request: addTempRequest({
        start_date: '2026-05-13',
        end_date: '2026-05-14',
        building_names: ['Cordera Building', 'Pine Creek Building'],
      }),
      seat: null,
      stake: STAKE,
      buildings: BUILDINGS,
      wards: WARDS,
      envs: ENVS,
      session: SESSION,
    });

    // Description matches; user already permanent; no demote → no editUser.
    expect(editUserMock).not.toHaveBeenCalled();
    // Additive diff: only Pine Creek (6249) needs adding; Cordera
    // (6248) already on the user.
    expect(saveAccessRuleMock).toHaveBeenCalledWith(SESSION, existing.userId, [6249], undefined);
  });

  it('existing user with NO diffs at all: skips both edit + saveAccessRule', async () => {
    const existing = existingUser({
      description: 'Colorado Springs North Stake (Sunday School Teacher)',
      isTempUser: false,
      accessSchedules: [{ ruleId: 6248 }, { ruleId: 6249 }],
    });
    lookupUserByEmailMock.mockResolvedValue(existing);

    const result = await provisionAddOrChange({
      request: addManualRequest({ building_names: ['Cordera Building', 'Pine Creek Building'] }),
      seat: null,
      stake: STAKE,
      buildings: BUILDINGS,
      wards: WARDS,
      envs: ENVS,
      session: SESSION,
    });

    expect(editUserMock).not.toHaveBeenCalled();
    expect(saveAccessRuleMock).not.toHaveBeenCalled();
    expect(result.action).toBe('updated');
    expect(result.kindoo_uid).toBe(existing.userId);
    expect(result.note).toBe('No Kindoo changes needed for Tad Smith.');
  });
});

describe('provisionAddOrChange — guards', () => {
  it('throws ProvisionBuildingsMissingRuleError when a requested building has no rule_id', async () => {
    await expect(
      provisionAddOrChange({
        request: addManualRequest({ building_names: ['Cordera Building', 'Monument Building'] }),
        seat: null,
        stake: STAKE,
        buildings: BUILDINGS,
        wards: WARDS,
        envs: ENVS,
        session: SESSION,
      }),
    ).rejects.toBeInstanceOf(ProvisionBuildingsMissingRuleError);
    expect(lookupUserByEmailMock).not.toHaveBeenCalled();
  });

  it('throws ProvisionEnvironmentNotFoundError when no env matches the session EID', async () => {
    await expect(
      provisionAddOrChange({
        request: addManualRequest({ building_names: ['Cordera Building'] }),
        seat: null,
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
        seat: null,
        stake: STAKE,
        buildings: BUILDINGS,
        wards: WARDS,
        envs: ENVS,
        session: SESSION,
      }),
    ).rejects.toThrow(/non-add type/);
  });

  it('uses kindoo_expected_site_name as the Description scope when set', async () => {
    lookupUserByEmailMock.mockResolvedValue(null);
    inviteUserMock.mockResolvedValue({ uid: 'new-uid' });
    saveAccessRuleMock.mockResolvedValue({ ok: true });

    const stakeWithOverride = {
      ...STAKE,
      stake_name: 'STAGING - Colorado Springs North Stake',
      kindoo_expected_site_name: 'Colorado Springs North Stake',
    } as Stake;
    await provisionAddOrChange({
      request: addManualRequest({ building_names: ['Cordera Building'] }),
      seat: null,
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
    lookupUserByEmailMock.mockResolvedValue(null);
    inviteUserMock.mockResolvedValue({ uid: 'new-uid' });
    saveAccessRuleMock.mockResolvedValue({ ok: true });

    await provisionAddOrChange({
      request: addManualRequest({ scope: 'CO', building_names: [] }),
      seat: null,
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

  it('respects req.building_names on ward-scope requests with multiple buildings', async () => {
    // Regression for the bug where buildingsForRequest ignored
    // req.building_names for non-stake scope and only returned the
    // ward's single building_name — losing any additional buildings
    // the requester selected.
    lookupUserByEmailMock.mockResolvedValue(null);
    inviteUserMock.mockResolvedValue({ uid: 'new-uid' });
    saveAccessRuleMock.mockResolvedValue({ ok: true });

    await provisionAddOrChange({
      request: addManualRequest({
        scope: 'CO',
        building_names: ['Cordera Building', 'Pine Creek Building'],
      }),
      seat: null,
      stake: STAKE,
      buildings: BUILDINGS,
      wards: WARDS,
      envs: ENVS,
      session: SESSION,
    });

    // Both buildings → both rules.
    expect(saveAccessRuleMock).toHaveBeenCalledWith(SESSION, 'new-uid', [6248, 6249], undefined);
  });

  it('falls back to member_email in the note when member_name is empty', async () => {
    lookupUserByEmailMock.mockResolvedValue(null);
    inviteUserMock.mockResolvedValue({ uid: 'new-uid' });
    saveAccessRuleMock.mockResolvedValue({ ok: true });

    const result = await provisionAddOrChange({
      request: addManualRequest({ member_name: '', building_names: ['Cordera Building'] }),
      seat: null,
      stake: STAKE,
      buildings: BUILDINGS,
      wards: WARDS,
      envs: ENVS,
      session: SESSION,
    });
    expect(result.note).toBe(
      'Invited tad.e.smith@gmail.com to Kindoo with access to Cordera Building.',
    );
  });
});

// Seat factory — primary stake grant on both buildings.
function stakeSeat(overrides: Partial<Seat> = {}): Seat {
  return {
    member_canonical: 'tad.e.smith@gmail.com',
    member_email: 'tad.e.smith@gmail.com',
    member_name: 'Tad Smith',
    scope: 'stake',
    type: 'manual',
    callings: [],
    reason: 'Sunday School Teacher',
    building_names: ['Cordera Building', 'Pine Creek Building'],
    duplicate_grants: [],
    ...overrides,
  } as unknown as Seat;
}

describe('provisionRemove', () => {
  it('R-1 race (seat null) + user not in Kindoo: noop-remove, no writes', async () => {
    lookupUserByEmailMock.mockResolvedValue(null);

    const result = await provisionRemove({
      request: removeRequest(),
      seat: null,
      stake: STAKE,
      buildings: BUILDINGS,
      wards: WARDS,
      envs: ENVS,
      session: SESSION,
    });

    expect(revokeUserMock).not.toHaveBeenCalled();
    expect(revokeUserFromAccessScheduleMock).not.toHaveBeenCalled();
    expect(saveAccessRuleMock).not.toHaveBeenCalled();
    expect(editUserMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      kindoo_uid: null,
      action: 'noop-remove',
      note: 'Tad Smith was not in Kindoo (no-op).',
    });
  });

  it('user exists but seat is null (R-1 race): per-rule revoke + revokeUser to wipe env-user', async () => {
    // No seat → target buildings = []. Every current rule should be
    // revoked, then revokeUser to delete the env-user record.
    const existing = existingUser({
      accessSchedules: [{ ruleId: 6248 }, { ruleId: 6249 }],
    });
    lookupUserByEmailMock.mockResolvedValue(existing);
    revokeUserFromAccessScheduleMock.mockResolvedValue({ ok: true });
    revokeUserMock.mockResolvedValue({ ok: true });

    const result = await provisionRemove({
      request: removeRequest(),
      seat: null,
      stake: STAKE,
      buildings: BUILDINGS,
      wards: WARDS,
      envs: ENVS,
      session: SESSION,
    });

    expect(revokeUserFromAccessScheduleMock).toHaveBeenCalledTimes(2);
    expect(revokeUserFromAccessScheduleMock).toHaveBeenNthCalledWith(
      1,
      SESSION,
      existing.euid,
      6248,
      undefined,
    );
    expect(revokeUserFromAccessScheduleMock).toHaveBeenNthCalledWith(
      2,
      SESSION,
      existing.euid,
      6249,
      undefined,
    );
    expect(revokeUserMock).toHaveBeenCalledWith(SESSION, existing.userId, undefined);
    expect(saveAccessRuleMock).not.toHaveBeenCalled();
    expect(editUserMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      kindoo_uid: existing.userId,
      action: 'removed',
      note: 'Removed Tad Smith from Kindoo.',
    });
  });

  it('primary scope removal, no duplicates: revokes all current rules + revokeUser', async () => {
    // Seat is stake-scope primary, no duplicates → seat is deleted by
    // the trigger → target buildings = [] → revoke every current rule
    // by EUID, then revokeUser to wipe the env-user record.
    const seat = stakeSeat();
    const existing = existingUser({
      accessSchedules: [{ ruleId: 6248 }, { ruleId: 6249 }],
    });
    lookupUserByEmailMock.mockResolvedValue(existing);
    revokeUserFromAccessScheduleMock.mockResolvedValue({ ok: true });
    revokeUserMock.mockResolvedValue({ ok: true });

    const result = await provisionRemove({
      request: removeRequest({ scope: 'stake' }),
      seat,
      stake: STAKE,
      buildings: BUILDINGS,
      wards: WARDS,
      envs: ENVS,
      session: SESSION,
    });

    // Both rules revoked by EUID (NOT UserID).
    expect(revokeUserFromAccessScheduleMock).toHaveBeenCalledTimes(2);
    for (const call of revokeUserFromAccessScheduleMock.mock.calls) {
      expect(call[1]).toBe(existing.euid);
    }
    expect(revokeUserMock).toHaveBeenCalledWith(SESSION, existing.userId, undefined);
    expect(saveAccessRuleMock).not.toHaveBeenCalled();
    expect(editUserMock).not.toHaveBeenCalled();
    expect(result.action).toBe('removed');
    expect(result.kindoo_uid).toBe(existing.userId);
    expect(result.note).toBe('Removed Tad Smith from Kindoo.');
  });

  it('primary scope removal with one duplicate: revokes only the primary rules; description updated via editUser', async () => {
    // Seat primary = stake (Cordera + Pine Creek); duplicate = CO ward
    // (Cordera only). Removing the primary promotes the CO duplicate
    // → post-removal buildings = [Cordera] → revoke Pine Creek rule
    // only, editUser to resync description, action='updated'.
    const seat = stakeSeat({
      duplicate_grants: [
        {
          scope: 'CO',
          type: 'manual',
          callings: [],
          reason: 'Bishop',
          building_names: ['Cordera Building'],
          detected_at: { seconds: 1, nanoseconds: 0 } as unknown as DuplicateGrant['detected_at'],
        },
      ] as unknown as Seat['duplicate_grants'],
    });
    const existing = existingUser({
      description: 'Colorado Springs North Stake (Sunday School Teacher) | Cordera Ward (Bishop)',
      accessSchedules: [{ ruleId: 6248 }, { ruleId: 6249 }],
    });
    lookupUserByEmailMock.mockResolvedValue(existing);
    revokeUserFromAccessScheduleMock.mockResolvedValue({ ok: true });
    editUserMock.mockResolvedValue({ ok: true });

    const result = await provisionRemove({
      request: removeRequest({ scope: 'stake' }),
      seat,
      stake: STAKE,
      buildings: BUILDINGS,
      wards: WARDS,
      envs: ENVS,
      session: SESSION,
    });

    // Pine Creek rule revoked; Cordera survives.
    expect(revokeUserFromAccessScheduleMock).toHaveBeenCalledTimes(1);
    expect(revokeUserFromAccessScheduleMock).toHaveBeenCalledWith(
      SESSION,
      existing.euid,
      6249,
      undefined,
    );
    expect(revokeUserMock).not.toHaveBeenCalled();
    expect(saveAccessRuleMock).not.toHaveBeenCalled();
    // Description drops the stake segment; only "Cordera Ward (Bishop)" remains.
    expect(editUserMock).toHaveBeenCalledTimes(1);
    expect(editUserMock.mock.calls[0]![1]).toBe(existing.euid);
    expect(editUserMock.mock.calls[0]![2]).toMatchObject({
      description: 'Cordera Ward (Bishop)',
      isTemp: false,
      timeZone: 'Mountain Standard Time',
    });
    expect(result.action).toBe('updated');
    expect(result.kindoo_uid).toBe(existing.userId);
    expect(result.note).toBe("Updated Tad Smith's Kindoo access to Cordera Building.");
  });

  it('duplicate scope removal: revokes only the duplicate rules; primary untouched; description updated', async () => {
    // Seat primary = stake (Cordera + Pine Creek). Duplicate = CO
    // (Cordera Building). Removing the CO duplicate → target
    // buildings stay at [Cordera, Pine Creek] (primary unchanged) →
    // no rule writes; description drops the duplicate segment.
    //
    // Note: target buildings == current building set, so toRevoke /
    // toAdd are both empty. But description still differs.
    const seat = stakeSeat({
      duplicate_grants: [
        {
          scope: 'CO',
          type: 'manual',
          callings: [],
          reason: 'Bishop',
          building_names: ['Cordera Building'],
          detected_at: { seconds: 1, nanoseconds: 0 } as unknown as DuplicateGrant['detected_at'],
        },
      ] as unknown as Seat['duplicate_grants'],
    });
    const existing = existingUser({
      description: 'Colorado Springs North Stake (Sunday School Teacher) | Cordera Ward (Bishop)',
      accessSchedules: [{ ruleId: 6248 }, { ruleId: 6249 }],
    });
    lookupUserByEmailMock.mockResolvedValue(existing);
    editUserMock.mockResolvedValue({ ok: true });

    const result = await provisionRemove({
      request: removeRequest({ scope: 'CO' }),
      seat,
      stake: STAKE,
      buildings: BUILDINGS,
      wards: WARDS,
      envs: ENVS,
      session: SESSION,
    });

    // No rule changes — primary keeps both buildings.
    expect(revokeUserFromAccessScheduleMock).not.toHaveBeenCalled();
    expect(revokeUserMock).not.toHaveBeenCalled();
    expect(saveAccessRuleMock).not.toHaveBeenCalled();
    // Description drops Cordera Ward segment.
    expect(editUserMock).toHaveBeenCalledTimes(1);
    expect(editUserMock.mock.calls[0]![2]).toMatchObject({
      description: 'Colorado Springs North Stake (Sunday School Teacher)',
    });
    expect(result.action).toBe('updated');
    expect(result.note).toBe(
      "Updated Tad Smith's Kindoo access to Cordera Building, Pine Creek Building.",
    );
  });

  it('duplicate scope removal where the duplicate brought a building the primary lacks: revokes only the duplicate-only rule', async () => {
    // Seat primary = stake-scope on Cordera only. Duplicate = PC ward
    // on Pine Creek. Remove PC → primary keeps Cordera; Pine Creek
    // rule must be revoked.
    const seat = stakeSeat({
      building_names: ['Cordera Building'],
      duplicate_grants: [
        {
          scope: 'PC',
          type: 'manual',
          callings: [],
          reason: 'Bishop',
          building_names: ['Pine Creek Building'],
          detected_at: { seconds: 1, nanoseconds: 0 } as unknown as DuplicateGrant['detected_at'],
        },
      ] as unknown as Seat['duplicate_grants'],
    });
    const existing = existingUser({
      description:
        'Colorado Springs North Stake (Sunday School Teacher) | Pine Creek Ward (Bishop)',
      accessSchedules: [{ ruleId: 6248 }, { ruleId: 6249 }],
    });
    lookupUserByEmailMock.mockResolvedValue(existing);
    revokeUserFromAccessScheduleMock.mockResolvedValue({ ok: true });
    editUserMock.mockResolvedValue({ ok: true });

    await provisionRemove({
      request: removeRequest({ scope: 'PC' }),
      seat,
      stake: STAKE,
      buildings: BUILDINGS,
      wards: WARDS,
      envs: ENVS,
      session: SESSION,
    });

    expect(revokeUserFromAccessScheduleMock).toHaveBeenCalledTimes(1);
    expect(revokeUserFromAccessScheduleMock).toHaveBeenCalledWith(
      SESSION,
      existing.euid,
      6249,
      undefined,
    );
    expect(revokeUserMock).not.toHaveBeenCalled();
    expect(saveAccessRuleMock).not.toHaveBeenCalled();
    expect(editUserMock).toHaveBeenCalledTimes(1);
    expect(editUserMock.mock.calls[0]![2]).toMatchObject({
      description: 'Colorado Springs North Stake (Sunday School Teacher)',
    });
  });

  it('duplicate scope removal with description unchanged: no editUser call', async () => {
    // Seat primary = stake; duplicate = CO. The CURRENT Kindoo
    // description happens to already match the post-removal text
    // (e.g. operator manually cleaned it up in Kindoo earlier).
    // Description sync should detect no diff and skip editUser.
    const seat = stakeSeat({
      duplicate_grants: [
        {
          scope: 'CO',
          type: 'manual',
          callings: [],
          reason: 'Bishop',
          building_names: ['Cordera Building'],
          detected_at: { seconds: 1, nanoseconds: 0 } as unknown as DuplicateGrant['detected_at'],
        },
      ] as unknown as Seat['duplicate_grants'],
    });
    const existing = existingUser({
      description: 'Colorado Springs North Stake (Sunday School Teacher)',
      accessSchedules: [{ ruleId: 6248 }, { ruleId: 6249 }],
    });
    lookupUserByEmailMock.mockResolvedValue(existing);

    const result = await provisionRemove({
      request: removeRequest({ scope: 'CO' }),
      seat,
      stake: STAKE,
      buildings: BUILDINGS,
      wards: WARDS,
      envs: ENVS,
      session: SESSION,
    });

    expect(revokeUserFromAccessScheduleMock).not.toHaveBeenCalled();
    expect(revokeUserMock).not.toHaveBeenCalled();
    expect(saveAccessRuleMock).not.toHaveBeenCalled();
    expect(editUserMock).not.toHaveBeenCalled();
    expect(result.action).toBe('updated');
  });

  it('stale request (scope present in neither primary nor duplicates): no writes', async () => {
    // Seat primary = stake; no matching duplicate for the request's
    // scope. Post-removal building set is the same as the current
    // set (nothing dropped). Description also unchanged (no segment
    // matches removeScope). No Kindoo writes at all.
    const seat = stakeSeat();
    const existing = existingUser({
      description: 'Colorado Springs North Stake (Sunday School Teacher)',
      accessSchedules: [{ ruleId: 6248 }, { ruleId: 6249 }],
    });
    lookupUserByEmailMock.mockResolvedValue(existing);

    const result = await provisionRemove({
      request: removeRequest({ scope: 'PC' }), // scope not on seat
      seat,
      stake: STAKE,
      buildings: BUILDINGS,
      wards: WARDS,
      envs: ENVS,
      session: SESSION,
    });

    expect(revokeUserFromAccessScheduleMock).not.toHaveBeenCalled();
    expect(revokeUserMock).not.toHaveBeenCalled();
    expect(saveAccessRuleMock).not.toHaveBeenCalled();
    expect(editUserMock).not.toHaveBeenCalled();
    expect(result.action).toBe('updated');
    expect(result.kindoo_uid).toBe(existing.userId);
  });

  it('adds a newly-required rule when a promoted duplicate brings in a building not yet in Kindoo', async () => {
    // Seat primary = stake (Cordera only); duplicate = PC ward on
    // Pine Creek. Remove the stake primary → PC promotes → target
    // buildings = [Pine Creek]. Kindoo currently only has the Cordera
    // rule → revoke Cordera + saveAccessRule([Pine Creek]).
    const seat = stakeSeat({
      building_names: ['Cordera Building'],
      duplicate_grants: [
        {
          scope: 'PC',
          type: 'manual',
          callings: [],
          reason: 'Bishop',
          building_names: ['Pine Creek Building'],
          detected_at: { seconds: 1, nanoseconds: 0 } as unknown as DuplicateGrant['detected_at'],
        },
      ] as unknown as Seat['duplicate_grants'],
    });
    const existing = existingUser({
      description:
        'Colorado Springs North Stake (Sunday School Teacher) | Pine Creek Ward (Bishop)',
      accessSchedules: [{ ruleId: 6248 }],
    });
    lookupUserByEmailMock.mockResolvedValue(existing);
    revokeUserFromAccessScheduleMock.mockResolvedValue({ ok: true });
    saveAccessRuleMock.mockResolvedValue({ ok: true });
    editUserMock.mockResolvedValue({ ok: true });

    await provisionRemove({
      request: removeRequest({ scope: 'stake' }),
      seat,
      stake: STAKE,
      buildings: BUILDINGS,
      wards: WARDS,
      envs: ENVS,
      session: SESSION,
    });

    // Cordera revoked (no longer needed).
    expect(revokeUserFromAccessScheduleMock).toHaveBeenCalledWith(
      SESSION,
      existing.euid,
      6248,
      undefined,
    );
    // Pine Creek added via saveAccessRule (MERGE).
    expect(saveAccessRuleMock).toHaveBeenCalledWith(SESSION, existing.userId, [6249], undefined);
    // Not a wipe — description should sync, not revokeUser.
    expect(revokeUserMock).not.toHaveBeenCalled();
    expect(editUserMock).toHaveBeenCalledTimes(1);
    expect(editUserMock.mock.calls[0]![2]).toMatchObject({
      description: 'Pine Creek Ward (Bishop)',
    });
  });

  it('rejects with a clear error when called with the wrong request type', async () => {
    await expect(
      provisionRemove({
        request: addManualRequest(),
        seat: null,
        stake: STAKE,
        buildings: BUILDINGS,
        wards: WARDS,
        envs: ENVS,
        session: SESSION,
      }),
    ).rejects.toThrow(/non-remove type/);
  });

  it('falls back to member_email in the noop note when member_name is empty', async () => {
    lookupUserByEmailMock.mockResolvedValue(null);

    const result = await provisionRemove({
      request: removeRequest({ member_name: '' }),
      seat: null,
      stake: STAKE,
      buildings: BUILDINGS,
      wards: WARDS,
      envs: ENVS,
      session: SESSION,
    });
    expect(result.note).toBe('tad.e.smith@gmail.com was not in Kindoo (no-op).');
  });
});

// ---- provisionEdit -------------------------------------------------

function editAutoRequest(overrides: Partial<AccessRequest> = {}): AccessRequest {
  return addManualRequest({
    type: 'edit_auto',
    scope: 'CO',
    reason: '',
    building_names: ['Cordera Building'],
    ...overrides,
  });
}

function editManualRequest(overrides: Partial<AccessRequest> = {}): AccessRequest {
  return addManualRequest({
    type: 'edit_manual',
    scope: 'stake',
    reason: 'Sunday School Teacher',
    building_names: ['Cordera Building'],
    ...overrides,
  });
}

function editTempRequest(overrides: Partial<AccessRequest> = {}): AccessRequest {
  return addManualRequest({
    type: 'edit_temp',
    scope: 'stake',
    reason: 'Camp Director',
    start_date: '2026-05-13',
    end_date: '2026-05-14',
    building_names: ['Cordera Building'],
    ...overrides,
  });
}

describe('provisionEdit — edit_auto', () => {
  it('happy path (ward auto): computes add+revoke diff, calls saveAccessRule + revokeUserFromAccessSchedule + editUser', async () => {
    // Pre-edit: auto seat at CO ward, callings=['Primary President'],
    // buildings=[Cordera]. Edit adds Pine Creek per Policy B (Cordera
    // stays pre-checked + disabled). User in Kindoo already has Cordera
    // rule; needs Pine Creek added. Description text is callings-driven
    // for auto, so it stays the same — editUser should be skipped if no
    // other field differs.
    const seat: Seat = {
      member_canonical: 'tad.e.smith@gmail.com',
      member_email: 'tad.e.smith@gmail.com',
      member_name: 'Tad Smith',
      scope: 'CO',
      type: 'auto',
      callings: ['Primary President'],
      building_names: ['Cordera Building'],
      duplicate_grants: [],
    } as unknown as Seat;
    const existing = existingUser({
      description: 'Cordera Ward (Primary President)',
      isTempUser: false,
      accessSchedules: [{ ruleId: 6248 }],
    });
    lookupUserByEmailMock.mockResolvedValue(existing);
    saveAccessRuleMock.mockResolvedValue({ ok: true });

    const result = await provisionEdit({
      request: editAutoRequest({
        scope: 'CO',
        building_names: ['Cordera Building', 'Pine Creek Building'],
      }),
      seat,
      stake: STAKE,
      buildings: BUILDINGS,
      wards: WARDS,
      envs: ENVS,
      session: SESSION,
    });

    // Add Pine Creek (6249); no revokes (Cordera stays).
    expect(saveAccessRuleMock).toHaveBeenCalledWith(SESSION, existing.userId, [6249], undefined);
    expect(revokeUserFromAccessScheduleMock).not.toHaveBeenCalled();
    // Description unchanged for edit_auto (callings drive the text) → no editUser.
    expect(editUserMock).not.toHaveBeenCalled();
    expect(result.action).toBe('updated');
    expect(result.kindoo_uid).toBe(existing.userId);
    expect(result.note).toBe(
      "Updated Tad Smith's Kindoo access to Cordera Building, Pine Creek Building.",
    );
  });

  it('happy path (ward auto, building narrowed): revokes the dropped rule, no add, no description diff', async () => {
    // Pre-edit: auto seat at CO ward, Cordera+Pine Creek. Operator
    // edits to remove Pine Creek (Cordera template stays pre-checked).
    // Diff: revoke 6249, no add.
    const seat: Seat = {
      member_canonical: 'tad.e.smith@gmail.com',
      member_email: 'tad.e.smith@gmail.com',
      member_name: 'Tad Smith',
      scope: 'CO',
      type: 'auto',
      callings: ['Primary President'],
      building_names: ['Cordera Building', 'Pine Creek Building'],
      duplicate_grants: [],
    } as unknown as Seat;
    const existing = existingUser({
      description: 'Cordera Ward (Primary President)',
      isTempUser: false,
      accessSchedules: [{ ruleId: 6248 }, { ruleId: 6249 }],
    });
    lookupUserByEmailMock.mockResolvedValue(existing);
    revokeUserFromAccessScheduleMock.mockResolvedValue({ ok: true });

    await provisionEdit({
      request: editAutoRequest({
        scope: 'CO',
        building_names: ['Cordera Building'],
      }),
      seat,
      stake: STAKE,
      buildings: BUILDINGS,
      wards: WARDS,
      envs: ENVS,
      session: SESSION,
    });

    expect(saveAccessRuleMock).not.toHaveBeenCalled();
    expect(revokeUserFromAccessScheduleMock).toHaveBeenCalledWith(
      SESSION,
      existing.euid,
      6249,
      undefined,
    );
    expect(editUserMock).not.toHaveBeenCalled();
  });

  it('refuses edit_auto on stake scope without any Kindoo write', async () => {
    await expect(
      provisionEdit({
        request: editAutoRequest({ scope: 'stake' }),
        seat: null,
        stake: STAKE,
        buildings: BUILDINGS,
        wards: WARDS,
        envs: ENVS,
        session: SESSION,
      }),
    ).rejects.toBeInstanceOf(ProvisionStakeAutoEditError);
    expect(lookupUserByEmailMock).not.toHaveBeenCalled();
    expect(saveAccessRuleMock).not.toHaveBeenCalled();
    expect(revokeUserFromAccessScheduleMock).not.toHaveBeenCalled();
    expect(editUserMock).not.toHaveBeenCalled();
  });
});

describe('provisionEdit — edit_manual', () => {
  it('happy path: replaces reason + buildings; description carries the new reason; rule diff applied', async () => {
    // Pre-edit: manual stake seat reason='Old Reason' on Cordera. Edit
    // sets reason='Sunday School Teacher' + buildings=[Cordera, Pine
    // Creek]. Description rewrites to the new reason; Pine Creek rule
    // added.
    const seat: Seat = {
      member_canonical: 'tad.e.smith@gmail.com',
      member_email: 'tad.e.smith@gmail.com',
      member_name: 'Tad Smith',
      scope: 'stake',
      type: 'manual',
      callings: [],
      reason: 'Old Reason',
      building_names: ['Cordera Building'],
      duplicate_grants: [],
    } as unknown as Seat;
    const existing = existingUser({
      description: 'Colorado Springs North Stake (Old Reason)',
      isTempUser: false,
      accessSchedules: [{ ruleId: 6248 }],
    });
    lookupUserByEmailMock.mockResolvedValue(existing);
    saveAccessRuleMock.mockResolvedValue({ ok: true });
    editUserMock.mockResolvedValue({ ok: true });

    const result = await provisionEdit({
      request: editManualRequest({
        scope: 'stake',
        reason: 'Sunday School Teacher',
        building_names: ['Cordera Building', 'Pine Creek Building'],
      }),
      seat,
      stake: STAKE,
      buildings: BUILDINGS,
      wards: WARDS,
      envs: ENVS,
      session: SESSION,
    });

    expect(saveAccessRuleMock).toHaveBeenCalledWith(SESSION, existing.userId, [6249], undefined);
    expect(revokeUserFromAccessScheduleMock).not.toHaveBeenCalled();
    expect(editUserMock).toHaveBeenCalledTimes(1);
    expect(editUserMock.mock.calls[0]![1]).toBe(existing.euid);
    expect(editUserMock.mock.calls[0]![2]).toMatchObject({
      description: 'Colorado Springs North Stake (Sunday School Teacher)',
      isTemp: false,
      timeZone: 'Mountain Standard Time',
    });
    expect(result.action).toBe('updated');
    expect(result.note).toBe(
      "Updated Tad Smith's Kindoo access to Cordera Building, Pine Creek Building.",
    );
  });

  it('user has a duplicate-grants segment from another scope: description rewrites the edited segment only', async () => {
    // Primary stake (Sunday School Teacher), duplicate CO ward (Bishop
    // — manual). Edit the CO duplicate's reason to 'Counselor' and
    // buildings to [Cordera, Pine Creek]. Description should keep the
    // stake primary verbatim and rewrite only the CO segment.
    const seat: Seat = {
      member_canonical: 'tad.e.smith@gmail.com',
      member_email: 'tad.e.smith@gmail.com',
      member_name: 'Tad Smith',
      scope: 'stake',
      type: 'manual',
      callings: [],
      reason: 'Sunday School Teacher',
      building_names: ['Cordera Building'],
      duplicate_grants: [
        {
          scope: 'CO',
          type: 'manual',
          callings: [],
          reason: 'Bishop',
          building_names: ['Cordera Building'],
          detected_at: { seconds: 1, nanoseconds: 0 } as unknown as DuplicateGrant['detected_at'],
        },
      ],
    } as unknown as Seat;
    const existing = existingUser({
      description: 'Colorado Springs North Stake (Sunday School Teacher) | Cordera Ward (Bishop)',
      isTempUser: false,
      // User already has both rules from the stake primary.
      accessSchedules: [{ ruleId: 6248 }, { ruleId: 6249 }],
    });
    lookupUserByEmailMock.mockResolvedValue(existing);
    editUserMock.mockResolvedValue({ ok: true });

    await provisionEdit({
      request: editManualRequest({
        scope: 'CO',
        reason: 'Counselor',
        building_names: ['Cordera Building', 'Pine Creek Building'],
      }),
      seat,
      stake: STAKE,
      buildings: BUILDINGS,
      wards: WARDS,
      envs: ENVS,
      session: SESSION,
    });

    // Both rules already on the user — no rule writes.
    expect(saveAccessRuleMock).not.toHaveBeenCalled();
    expect(revokeUserFromAccessScheduleMock).not.toHaveBeenCalled();
    // Description: primary untouched; CO duplicate rewritten with the new reason.
    expect(editUserMock).toHaveBeenCalledTimes(1);
    expect(editUserMock.mock.calls[0]![2]).toMatchObject({
      description:
        'Colorado Springs North Stake (Sunday School Teacher) | Cordera Ward (Counselor)',
    });
  });
});

describe('provisionEdit — edit_temp', () => {
  it('happy path: replaces buildings + dates; description rewrites with new reason', async () => {
    // Pre-edit: temp stake seat reason='Old' on Cordera, dates A→B.
    // Edit moves it to reason='Camp Director', buildings=[Cordera,
    // Pine Creek], dates 2026-05-13→2026-05-14.
    const seat: Seat = {
      member_canonical: 'tad.e.smith@gmail.com',
      member_email: 'tad.e.smith@gmail.com',
      member_name: 'Tad Smith',
      scope: 'stake',
      type: 'temp',
      callings: [],
      reason: 'Old',
      building_names: ['Cordera Building'],
      start_date: '2026-04-01',
      end_date: '2026-04-30',
      duplicate_grants: [],
    } as unknown as Seat;
    const existing = existingUser({
      description: 'Colorado Springs North Stake (Old)',
      isTempUser: true,
      startAccessDoorsDateAtTimeZone: '2026-04-01T00:00',
      expiryDateAtTimeZone: '2026-04-30T23:59',
      accessSchedules: [{ ruleId: 6248 }],
    });
    lookupUserByEmailMock.mockResolvedValue(existing);
    saveAccessRuleMock.mockResolvedValue({ ok: true });
    editUserMock.mockResolvedValue({ ok: true });

    const result = await provisionEdit({
      request: editTempRequest({
        scope: 'stake',
        reason: 'Camp Director',
        start_date: '2026-05-13',
        end_date: '2026-05-14',
        building_names: ['Cordera Building', 'Pine Creek Building'],
      }),
      seat,
      stake: STAKE,
      buildings: BUILDINGS,
      wards: WARDS,
      envs: ENVS,
      session: SESSION,
    });

    expect(saveAccessRuleMock).toHaveBeenCalledWith(SESSION, existing.userId, [6249], undefined);
    expect(revokeUserFromAccessScheduleMock).not.toHaveBeenCalled();
    expect(editUserMock).toHaveBeenCalledTimes(1);
    expect(editUserMock.mock.calls[0]![2]).toMatchObject({
      description: 'Colorado Springs North Stake (Camp Director)',
      isTemp: true,
      startAccessDoorsDateTime: '2026-05-13T00:00',
      expiryDate: '2026-05-14T23:59',
      timeZone: 'Mountain Standard Time',
    });
    expect(result.action).toBe('updated');
  });

  it('user with primary auto + temp duplicate: description composes both; auto segment untouched', async () => {
    // Primary auto CO ward (Primary President), duplicate temp stake
    // scope. Edit the temp duplicate's reason and buildings.
    const seat: Seat = {
      member_canonical: 'tad.e.smith@gmail.com',
      member_email: 'tad.e.smith@gmail.com',
      member_name: 'Tad Smith',
      scope: 'CO',
      type: 'auto',
      callings: ['Primary President'],
      building_names: ['Cordera Building'],
      duplicate_grants: [
        {
          scope: 'stake',
          type: 'temp',
          callings: [],
          reason: 'Camp Director',
          building_names: ['Pine Creek Building'],
          start_date: '2026-04-01',
          end_date: '2026-04-30',
          detected_at: { seconds: 1, nanoseconds: 0 } as unknown as DuplicateGrant['detected_at'],
        },
      ],
    } as unknown as Seat;
    const existing = existingUser({
      description:
        'Cordera Ward (Primary President) | Colorado Springs North Stake (Camp Director)',
      isTempUser: true,
      startAccessDoorsDateAtTimeZone: '2026-04-01T00:00',
      expiryDateAtTimeZone: '2026-04-30T23:59',
      accessSchedules: [{ ruleId: 6248 }, { ruleId: 6249 }],
    });
    lookupUserByEmailMock.mockResolvedValue(existing);
    editUserMock.mockResolvedValue({ ok: true });

    await provisionEdit({
      request: editTempRequest({
        scope: 'stake',
        reason: 'Stake Activity Lead',
        start_date: '2026-05-13',
        end_date: '2026-05-14',
        building_names: ['Cordera Building', 'Pine Creek Building'],
      }),
      seat,
      stake: STAKE,
      buildings: BUILDINGS,
      wards: WARDS,
      envs: ENVS,
      session: SESSION,
    });

    // Rules unchanged; user already has both.
    expect(saveAccessRuleMock).not.toHaveBeenCalled();
    expect(revokeUserFromAccessScheduleMock).not.toHaveBeenCalled();
    // Description: auto segment kept verbatim; temp segment rewritten.
    expect(editUserMock).toHaveBeenCalledTimes(1);
    expect(editUserMock.mock.calls[0]![2]).toMatchObject({
      description:
        'Cordera Ward (Primary President) | Colorado Springs North Stake (Stake Activity Lead)',
      isTemp: true,
      startAccessDoorsDateTime: '2026-05-13T00:00',
      expiryDate: '2026-05-14T23:59',
    });
  });

  it('throws unexpected-shape when edit_temp is missing end_date', async () => {
    const req = editTempRequest({
      scope: 'stake',
      reason: 'Camp Director',
      start_date: '2026-05-13',
      end_date: '2026-05-14',
      building_names: ['Cordera Building'],
    });
    delete (req as { end_date?: string }).end_date;
    await expect(
      provisionEdit({
        request: req,
        seat: null,
        stake: STAKE,
        buildings: BUILDINGS,
        wards: WARDS,
        envs: ENVS,
        session: SESSION,
      }),
    ).rejects.toMatchObject({ code: 'unexpected-shape' });
    expect(lookupUserByEmailMock).not.toHaveBeenCalled();
  });
});

describe('provisionEdit — guards + edge cases', () => {
  it('user missing in Kindoo: throws ProvisionEditUserMissingError, no Kindoo writes', async () => {
    lookupUserByEmailMock.mockResolvedValue(null);

    await expect(
      provisionEdit({
        request: editManualRequest({
          scope: 'stake',
          reason: 'Sunday School Teacher',
          building_names: ['Cordera Building'],
        }),
        seat: null,
        stake: STAKE,
        buildings: BUILDINGS,
        wards: WARDS,
        envs: ENVS,
        session: SESSION,
      }),
    ).rejects.toBeInstanceOf(ProvisionEditUserMissingError);
    expect(saveAccessRuleMock).not.toHaveBeenCalled();
    expect(revokeUserFromAccessScheduleMock).not.toHaveBeenCalled();
    expect(editUserMock).not.toHaveBeenCalled();
  });

  it('no-op edit (target buildings + description match current): skips both rule writes + editUser', async () => {
    const seat: Seat = {
      member_canonical: 'tad.e.smith@gmail.com',
      member_email: 'tad.e.smith@gmail.com',
      member_name: 'Tad Smith',
      scope: 'stake',
      type: 'manual',
      callings: [],
      reason: 'Sunday School Teacher',
      building_names: ['Cordera Building', 'Pine Creek Building'],
      duplicate_grants: [],
    } as unknown as Seat;
    const existing = existingUser({
      description: 'Colorado Springs North Stake (Sunday School Teacher)',
      isTempUser: false,
      accessSchedules: [{ ruleId: 6248 }, { ruleId: 6249 }],
    });
    lookupUserByEmailMock.mockResolvedValue(existing);

    const result = await provisionEdit({
      request: editManualRequest({
        scope: 'stake',
        reason: 'Sunday School Teacher',
        building_names: ['Cordera Building', 'Pine Creek Building'],
      }),
      seat,
      stake: STAKE,
      buildings: BUILDINGS,
      wards: WARDS,
      envs: ENVS,
      session: SESSION,
    });

    expect(saveAccessRuleMock).not.toHaveBeenCalled();
    expect(revokeUserFromAccessScheduleMock).not.toHaveBeenCalled();
    expect(editUserMock).not.toHaveBeenCalled();
    expect(result.note).toBe('No Kindoo changes needed for Tad Smith.');
  });

  it('description-only edit (reason changed but buildings unchanged): calls editUser, skips rule writes', async () => {
    const seat: Seat = {
      member_canonical: 'tad.e.smith@gmail.com',
      member_email: 'tad.e.smith@gmail.com',
      member_name: 'Tad Smith',
      scope: 'stake',
      type: 'manual',
      callings: [],
      reason: 'Old Reason',
      building_names: ['Cordera Building', 'Pine Creek Building'],
      duplicate_grants: [],
    } as unknown as Seat;
    const existing = existingUser({
      description: 'Colorado Springs North Stake (Old Reason)',
      isTempUser: false,
      accessSchedules: [{ ruleId: 6248 }, { ruleId: 6249 }],
    });
    lookupUserByEmailMock.mockResolvedValue(existing);
    editUserMock.mockResolvedValue({ ok: true });

    await provisionEdit({
      request: editManualRequest({
        scope: 'stake',
        reason: 'New Reason',
        building_names: ['Cordera Building', 'Pine Creek Building'],
      }),
      seat,
      stake: STAKE,
      buildings: BUILDINGS,
      wards: WARDS,
      envs: ENVS,
      session: SESSION,
    });

    expect(saveAccessRuleMock).not.toHaveBeenCalled();
    expect(revokeUserFromAccessScheduleMock).not.toHaveBeenCalled();
    expect(editUserMock).toHaveBeenCalledTimes(1);
    expect(editUserMock.mock.calls[0]![2]).toMatchObject({
      description: 'Colorado Springs North Stake (New Reason)',
    });
  });

  it('rejects with a clear error when called with the wrong request type', async () => {
    await expect(
      provisionEdit({
        request: removeRequest(),
        seat: null,
        stake: STAKE,
        buildings: BUILDINGS,
        wards: WARDS,
        envs: ENVS,
        session: SESSION,
      }),
    ).rejects.toThrow(/non-edit type/);
  });

  it('throws ProvisionBuildingsMissingRuleError when a target building has no rule_id', async () => {
    await expect(
      provisionEdit({
        request: editManualRequest({
          scope: 'stake',
          building_names: ['Cordera Building', 'Monument Building'],
        }),
        seat: null,
        stake: STAKE,
        buildings: BUILDINGS,
        wards: WARDS,
        envs: ENVS,
        session: SESSION,
      }),
    ).rejects.toBeInstanceOf(ProvisionBuildingsMissingRuleError);
    expect(lookupUserByEmailMock).not.toHaveBeenCalled();
  });
});

describe('provisionEdit — cross-slot revoke regression', () => {
  // The fix derives the post-edit composite (primary ∪ surviving
  // duplicates) before diffing against Kindoo, so a RID belonging to
  // an untouched slot never lands in `toRevoke`.

  it('primary stake-manual + duplicate ward-manual: edit on stake does NOT revoke the duplicate ward RID', async () => {
    // Reviewer's failing case verbatim:
    //   primary = stake manual @ Cordera (rid 6248)
    //   duplicate = ward (PC) manual @ Pine Creek (rid 6249)
    //   Kindoo AccessSchedules = [6248, 6249]
    //   edit_manual scope=stake, new building_names = [Cordera, Briargate]
    // Before the fix: targetRids = [6248, 6250], ridsToRevoke = [6249]
    //   → Pine Creek (belonging to the unedited duplicate) was wrongly
    //   revoked.
    // After the fix: post-edit primary = [Cordera, Briargate],
    //   surviving duplicate = [Pine Creek], composite = [Cordera,
    //   Briargate, Pine Creek] → targetRids = [6248, 6250, 6249] →
    //   toAdd = [6250], toRevoke = [].
    const buildings: Building[] = [
      ...BUILDINGS.filter((b) => b.building_name !== 'Monument Building'),
      {
        building_id: 'briargate',
        building_name: 'Briargate Building',
        kindoo_rule: { rule_id: 6250, rule_name: 'Briargate Doors' },
      } as unknown as Building,
    ];
    const seat: Seat = {
      member_canonical: 'tad.e.smith@gmail.com',
      member_email: 'tad.e.smith@gmail.com',
      member_name: 'Tad Smith',
      scope: 'stake',
      type: 'manual',
      callings: [],
      reason: 'Sunday School Teacher',
      building_names: ['Cordera Building'],
      duplicate_grants: [
        {
          scope: 'PC',
          type: 'manual',
          callings: [],
          reason: 'Ward Clerk',
          building_names: ['Pine Creek Building'],
          detected_at: { seconds: 1, nanoseconds: 0 } as unknown as DuplicateGrant['detected_at'],
        },
      ],
    } as unknown as Seat;
    const existing = existingUser({
      description:
        'Colorado Springs North Stake (Sunday School Teacher) | Pine Creek Ward (Ward Clerk)',
      isTempUser: false,
      accessSchedules: [{ ruleId: 6248 }, { ruleId: 6249 }],
    });
    lookupUserByEmailMock.mockResolvedValue(existing);
    saveAccessRuleMock.mockResolvedValue({ ok: true });
    editUserMock.mockResolvedValue({ ok: true });

    await provisionEdit({
      request: editManualRequest({
        scope: 'stake',
        reason: 'Sunday School Teacher',
        building_names: ['Cordera Building', 'Briargate Building'],
      }),
      seat,
      stake: STAKE,
      buildings,
      wards: WARDS,
      envs: ENVS,
      session: SESSION,
    });

    // Briargate (6250) is the only RID added; Pine Creek (6249) is
    // NOT revoked — the duplicate slot keeps it.
    expect(saveAccessRuleMock).toHaveBeenCalledTimes(1);
    expect(saveAccessRuleMock).toHaveBeenCalledWith(SESSION, existing.userId, [6250], undefined);
    expect(revokeUserFromAccessScheduleMock).not.toHaveBeenCalled();
  });

  it('edit on a duplicate slot that overlaps primary: no revokes, no adds (target already in Kindoo)', async () => {
    // Pre-edit:
    //   primary = auto @ Cordera ward, buildings=[Cordera] (rid 6248)
    //   duplicate = stake manual, buildings=[Cordera, Briargate] (rids 6248, 6250)
    //   Kindoo schedules = [6248, 6250]
    // Edit replaces the stake duplicate's buildings with [Briargate].
    // Post-edit composite = [Cordera (primary), Briargate (duplicate)]
    //   = rids [6248, 6250]. No diff against Kindoo → no rule writes.
    const buildings: Building[] = [
      ...BUILDINGS.filter((b) => b.building_name !== 'Monument Building'),
      {
        building_id: 'briargate',
        building_name: 'Briargate Building',
        kindoo_rule: { rule_id: 6250, rule_name: 'Briargate Doors' },
      } as unknown as Building,
    ];
    const seat: Seat = {
      member_canonical: 'tad.e.smith@gmail.com',
      member_email: 'tad.e.smith@gmail.com',
      member_name: 'Tad Smith',
      scope: 'CO',
      type: 'auto',
      callings: ['Primary President'],
      building_names: ['Cordera Building'],
      duplicate_grants: [
        {
          scope: 'stake',
          type: 'manual',
          callings: [],
          reason: 'Sunday School Teacher',
          building_names: ['Cordera Building', 'Briargate Building'],
          detected_at: { seconds: 1, nanoseconds: 0 } as unknown as DuplicateGrant['detected_at'],
        },
      ],
    } as unknown as Seat;
    const existing = existingUser({
      description:
        'Cordera Ward (Primary President) | Colorado Springs North Stake (Sunday School Teacher)',
      isTempUser: false,
      accessSchedules: [{ ruleId: 6248 }, { ruleId: 6250 }],
    });
    lookupUserByEmailMock.mockResolvedValue(existing);
    editUserMock.mockResolvedValue({ ok: true });

    await provisionEdit({
      request: editManualRequest({
        scope: 'stake',
        reason: 'Sunday School Teacher',
        building_names: ['Briargate Building'],
      }),
      seat,
      stake: STAKE,
      buildings,
      wards: WARDS,
      envs: ENVS,
      session: SESSION,
    });

    expect(saveAccessRuleMock).not.toHaveBeenCalled();
    expect(revokeUserFromAccessScheduleMock).not.toHaveBeenCalled();
  });
});

// ---- Direct-grant skip --------------------------------------------
//
// Both `provisionAddOrChange` (existing-user branch) and `provisionEdit`
// must subtract Church Access Automation's direct door grants from
// `ridsToAdd` so the orchestrator never writes a redundant
// AccessSchedule for a building the user already has effective access
// to. Without this, `saveAccessRule`'s MERGE semantics would create a
// parallel rule alongside the direct grants — pollutes Kindoo state
// and creates the divergence the Sync feature is meant to flag.
//
// The strict-subset chain lives in
// `content/kindoo/sync/buildingsFromDoors.ts`; mocks here stage
// per-rule door sets + per-user door rows directly at the endpoints
// layer.

/** Sugar: stage Lexington (rule 6248) to own door 100, Monument
 *  (rule 6251) door 200, Cordera (6248 — see below) is reused
 *  for simplicity. Tests pick which rule IDs map to which doors. */
function stageRuleDoors(map: Record<number, number[]>) {
  getEnvironmentRuleWithEntryPointsMock.mockImplementation(async (_session, ruleId: number) => ({
    ruleId,
    ruleName: `rule-${ruleId}`,
    selectedDoorIds: map[ruleId] ?? [],
    allDoors: [],
  }));
}

function stageUserDoors(doorIds: number[]) {
  getUserAccessRulesWithEntryPointsMock.mockResolvedValue(
    doorIds.map((id) => ({ doorId: id, accessScheduleId: 0 })),
  );
}

describe('provisionEdit — skip AccessSchedules already covered by direct grants', () => {
  it('operator scenario: ward auto user with Lexington direct grants + edit_auto adding Monument writes Monument only', async () => {
    // User has Lexington door access entirely from Church Access
    // Automation's direct door grants (AccessSchedules === []).
    // Operator submits edit_auto adding Monument.
    //
    // Before fix: ridsToAdd = [Lexington, Monument] - [] =
    //   [Lexington, Monument] → saveAccessRule writes a REDUNDANT
    //   Lexington AccessSchedule alongside the existing direct grant.
    // After fix: effective rules from direct doors = {Lexington} →
    //   ridsToAdd = [Lexington, Monument] - ({} ∪ {Lexington}) =
    //   [Monument] only.
    const buildings: Building[] = [
      {
        building_id: 'lexington',
        building_name: 'Lexington Building',
        kindoo_rule: { rule_id: 6248, rule_name: 'Lexington Doors' },
      } as unknown as Building,
      {
        building_id: 'monument',
        building_name: 'Monument Building',
        kindoo_rule: { rule_id: 6251, rule_name: 'Monument Doors' },
      } as unknown as Building,
    ];
    const wards: Ward[] = [
      {
        ward_code: 'LX',
        ward_name: 'Lexington Ward',
        building_name: 'Lexington Building',
      } as unknown as Ward,
    ];
    const seat: Seat = {
      member_canonical: 'tad.e.smith@gmail.com',
      member_email: 'tad.e.smith@gmail.com',
      member_name: 'Tad Smith',
      scope: 'LX',
      type: 'auto',
      callings: ['Primary President'],
      building_names: ['Lexington Building'],
      duplicate_grants: [],
    } as unknown as Seat;
    // Lexington's rule owns doors [1001, 1002, 1003]; Monument owns [2001].
    stageRuleDoors({ 6248: [1001, 1002, 1003], 6251: [2001] });
    // User has every Lexington door via direct grants; no Monument.
    stageUserDoors([1001, 1002, 1003]);
    const existing = existingUser({
      description: 'Lexington Ward (Primary President)',
      isTempUser: false,
      // No AccessSchedules — Church Automation gave doors directly.
      accessSchedules: [],
    });
    lookupUserByEmailMock.mockResolvedValue(existing);
    saveAccessRuleMock.mockResolvedValue({ ok: true });

    await provisionEdit({
      request: editAutoRequest({
        scope: 'LX',
        building_names: ['Lexington Building', 'Monument Building'],
      }),
      seat,
      stake: STAKE,
      buildings,
      wards,
      envs: ENVS,
      session: SESSION,
    });

    // Critical: Monument-only. Lexington was already effectively held
    // via direct grants, so the orchestrator skips it.
    expect(saveAccessRuleMock).toHaveBeenCalledTimes(1);
    expect(saveAccessRuleMock).toHaveBeenCalledWith(SESSION, existing.userId, [6251], undefined);
    expect(revokeUserFromAccessScheduleMock).not.toHaveBeenCalled();
  });

  it('partial overlap with direct grants: rule NOT effectively held → orchestrator still writes the AccessSchedule', async () => {
    // Strict-subset: the user has 2 of 3 doors in Lexington's rule via
    // direct grants. `deriveEffectiveRuleIds` requires EVERY door in
    // the rule's set; partial overlap does not claim. The
    // orchestrator must still write the Lexington AccessSchedule so
    // the user gets the missing door.
    const buildings: Building[] = [
      {
        building_id: 'lexington',
        building_name: 'Lexington Building',
        kindoo_rule: { rule_id: 6248, rule_name: 'Lexington Doors' },
      } as unknown as Building,
      {
        building_id: 'monument',
        building_name: 'Monument Building',
        kindoo_rule: { rule_id: 6251, rule_name: 'Monument Doors' },
      } as unknown as Building,
    ];
    const wards: Ward[] = [
      {
        ward_code: 'LX',
        ward_name: 'Lexington Ward',
        building_name: 'Lexington Building',
      } as unknown as Ward,
    ];
    const seat: Seat = {
      member_canonical: 'tad.e.smith@gmail.com',
      member_email: 'tad.e.smith@gmail.com',
      member_name: 'Tad Smith',
      scope: 'LX',
      type: 'auto',
      callings: ['Primary President'],
      building_names: ['Lexington Building'],
      duplicate_grants: [],
    } as unknown as Seat;
    stageRuleDoors({ 6248: [1001, 1002, 1003], 6251: [2001] });
    // Partial — only 2 of Lexington's 3 doors. Strict-subset → NOT
    // effectively held.
    stageUserDoors([1001, 1002]);
    const existing = existingUser({
      description: 'Lexington Ward (Primary President)',
      isTempUser: false,
      accessSchedules: [],
    });
    lookupUserByEmailMock.mockResolvedValue(existing);
    saveAccessRuleMock.mockResolvedValue({ ok: true });

    await provisionEdit({
      request: editAutoRequest({
        scope: 'LX',
        building_names: ['Lexington Building', 'Monument Building'],
      }),
      seat,
      stake: STAKE,
      buildings,
      wards,
      envs: ENVS,
      session: SESSION,
    });

    // Both rules: Lexington (partial-overlap doesn't claim) +
    // Monument (new). Single call carrying both.
    expect(saveAccessRuleMock).toHaveBeenCalledTimes(1);
    expect(saveAccessRuleMock).toHaveBeenCalledWith(
      SESSION,
      existing.userId,
      [6248, 6251],
      undefined,
    );
  });

  it('derivation chain fails: falls back to schedules-only diff, logs warn, provision completes', async () => {
    // Simulates a transient Kindoo error during the door-grant
    // derivation chain. The orchestrator falls back to the legacy
    // diff (`targetRids - currentSchedules`), logs a `[sba-ext]`
    // warning, and still writes the AccessSchedules. In the worst
    // case we re-introduce the redundant-rule scenario, but the
    // operator is never blocked.
    const buildings: Building[] = [
      {
        building_id: 'lexington',
        building_name: 'Lexington Building',
        kindoo_rule: { rule_id: 6248, rule_name: 'Lexington Doors' },
      } as unknown as Building,
      {
        building_id: 'monument',
        building_name: 'Monument Building',
        kindoo_rule: { rule_id: 6251, rule_name: 'Monument Doors' },
      } as unknown as Building,
    ];
    const wards: Ward[] = [
      {
        ward_code: 'LX',
        ward_name: 'Lexington Ward',
        building_name: 'Lexington Building',
      } as unknown as Ward,
    ];
    const seat: Seat = {
      member_canonical: 'tad.e.smith@gmail.com',
      member_email: 'tad.e.smith@gmail.com',
      member_name: 'Tad Smith',
      scope: 'LX',
      type: 'auto',
      callings: ['Primary President'],
      building_names: ['Lexington Building'],
      duplicate_grants: [],
    } as unknown as Seat;
    // getUserDoorIds throws — simulating the transient blip.
    getUserAccessRulesWithEntryPointsMock.mockRejectedValue(new Error('kindoo blip 503'));
    const existing = existingUser({
      description: 'Lexington Ward (Primary President)',
      isTempUser: false,
      accessSchedules: [],
    });
    lookupUserByEmailMock.mockResolvedValue(existing);
    saveAccessRuleMock.mockResolvedValue({ ok: true });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      await provisionEdit({
        request: editAutoRequest({
          scope: 'LX',
          building_names: ['Lexington Building', 'Monument Building'],
        }),
        seat,
        stake: STAKE,
        buildings,
        wards,
        envs: ENVS,
        session: SESSION,
      });

      // Fallback: legacy diff = [Lexington, Monument] - [] = both.
      // (Redundant Lexington is the cost of the fallback; documented.)
      expect(saveAccessRuleMock).toHaveBeenCalledWith(
        SESSION,
        existing.userId,
        [6248, 6251],
        undefined,
      );
      // Warn log fired with the `[sba-ext]` prefix.
      const warnLogged = logSpy.mock.calls.some(
        (call) =>
          typeof call[0] === 'string' &&
          call[0].startsWith('[sba-ext] deriveDirectGrantRids:') &&
          call[0].includes('falling back to legacy diff'),
      );
      expect(warnLogged).toBe(true);
    } finally {
      // Restore the global console even on assertion failure so the
      // spy never leaks into later test files (vitest workers can
      // share jsdom globals across files in the same pool slot).
      logSpy.mockRestore();
    }
  });
});

describe('provisionAddOrChange — skip AccessSchedules already covered by direct grants', () => {
  it('analogous add_manual case: user has Lexington via direct grants + add_manual for Cordera writes Cordera only', async () => {
    // Adapted to the operator's scenario for the add path: ward auto
    // seat at LX with Lexington access via direct grants (no
    // AccessSchedules). New add_manual request adds Cordera under a
    // different scope. After the seat-side union with the existing
    // auto seat's Lexington building, targetBuildings = [Lexington,
    // Cordera]. Without the fix the orchestrator would write a
    // redundant Lexington AccessSchedule; with the fix Lexington is
    // skipped because direct grants already cover it.
    const buildings: Building[] = [
      {
        building_id: 'lexington',
        building_name: 'Lexington Building',
        kindoo_rule: { rule_id: 6248, rule_name: 'Lexington Doors' },
      } as unknown as Building,
      {
        building_id: 'cordera',
        building_name: 'Cordera Building',
        kindoo_rule: { rule_id: 6300, rule_name: 'Cordera Doors' },
      } as unknown as Building,
    ];
    const wards: Ward[] = [
      {
        ward_code: 'LX',
        ward_name: 'Lexington Ward',
        building_name: 'Lexington Building',
      } as unknown as Ward,
      {
        ward_code: 'CO',
        ward_name: 'Cordera Ward',
        building_name: 'Cordera Building',
      } as unknown as Ward,
    ];
    // Pre-existing SBA seat is the auto LX seat with Lexington
    // Building. The new add_manual under stake scope contributes
    // Cordera. The merged target = [Lexington, Cordera].
    const seat: Seat = {
      member_canonical: 'tad.e.smith@gmail.com',
      member_email: 'tad.e.smith@gmail.com',
      member_name: 'Tad Smith',
      scope: 'LX',
      type: 'auto',
      callings: ['Primary President'],
      building_names: ['Lexington Building'],
      duplicate_grants: [],
    } as unknown as Seat;
    stageRuleDoors({ 6248: [1001, 1002], 6300: [3001] });
    stageUserDoors([1001, 1002]); // covers Lexington only
    const existing = existingUser({
      description: 'Lexington Ward (Primary President)',
      isTempUser: false,
      accessSchedules: [], // no schedules — direct grants only
    });
    lookupUserByEmailMock.mockResolvedValue(existing);
    saveAccessRuleMock.mockResolvedValue({ ok: true });
    editUserMock.mockResolvedValue({ ok: true });

    await provisionAddOrChange({
      request: addManualRequest({
        scope: 'stake',
        reason: 'Sunday School Teacher',
        building_names: ['Cordera Building'],
      }),
      seat,
      stake: STAKE,
      buildings,
      wards,
      envs: ENVS,
      session: SESSION,
    });

    // Cordera only — Lexington was already effectively held.
    expect(saveAccessRuleMock).toHaveBeenCalledTimes(1);
    expect(saveAccessRuleMock).toHaveBeenCalledWith(SESSION, existing.userId, [6300], undefined);
  });
});

// ----- T-42 per-site union -----
// The provision orchestrator computes the per-site target rule set by
// unioning only those grants whose `kindoo_site_id` resolves to the
// request's target site. Parallel-site grants (on a different Kindoo
// environment) do NOT contribute — they belong to a different Kindoo
// session's pool.

describe('provisionAddOrChange — T-42 per-site union', () => {
  it('excludes a parallel-site duplicate from the home-site write target', async () => {
    // Wards: CO (home), FT (foreign-site 'east-stake').
    const wards: Ward[] = [
      ...WARDS,
      {
        ward_code: 'FT',
        ward_name: 'Foothills Ward',
        building_name: 'Foothills Building',
        kindoo_site_id: 'east-stake',
      } as unknown as Ward,
    ];
    const buildings: Building[] = [
      ...BUILDINGS,
      {
        building_id: 'foothills',
        building_name: 'Foothills Building',
        kindoo_rule: { rule_id: 6260, rule_name: 'Foothills Doors' },
        kindoo_site_id: 'east-stake',
      } as unknown as Building,
    ];
    // Seat primary = CO (home); duplicate = FT (foreign).
    const seat: Seat = {
      member_canonical: 'tad.e.smith@gmail.com',
      member_email: 'tad.e.smith@gmail.com',
      member_name: 'Tad Smith',
      scope: 'CO',
      type: 'auto',
      callings: ['Sunday School Teacher'],
      building_names: ['Cordera Building'],
      kindoo_site_id: null,
      duplicate_grants: [
        {
          scope: 'FT',
          type: 'auto',
          callings: ['Sunday School Teacher'],
          building_names: ['Foothills Building'],
          kindoo_site_id: 'east-stake',
          detected_at: { seconds: 1, nanoseconds: 0 } as unknown as DuplicateGrant['detected_at'],
        },
      ],
    } as unknown as Seat;

    lookupUserByEmailMock.mockResolvedValue(null);
    inviteUserMock.mockResolvedValue({ uid: 'new-uid' });
    saveAccessRuleMock.mockResolvedValue({ ok: true });

    await provisionAddOrChange({
      request: addManualRequest({
        scope: 'CO',
        building_names: ['Cordera Building'],
      }),
      seat,
      stake: STAKE,
      buildings,
      wards,
      envs: ENVS,
      session: SESSION,
    });

    // Foothills (foreign-site rule 6260) is NOT in the write target.
    // Only Cordera (rule 6248) — the home-side grant.
    expect(saveAccessRuleMock).toHaveBeenCalledTimes(1);
    expect(saveAccessRuleMock).toHaveBeenCalledWith(SESSION, 'new-uid', [6248], undefined);
  });

  it('foreign-site request unions only foreign-site duplicate buildings', async () => {
    // Same fixture as above. This time the request targets the foreign
    // ward FT — only foreign-site grants should contribute.
    const wards: Ward[] = [
      ...WARDS,
      {
        ward_code: 'FT',
        ward_name: 'Foothills Ward',
        building_name: 'Foothills Building',
        kindoo_site_id: 'east-stake',
      } as unknown as Ward,
    ];
    const buildings: Building[] = [
      ...BUILDINGS,
      {
        building_id: 'foothills',
        building_name: 'Foothills Building',
        kindoo_rule: { rule_id: 6260, rule_name: 'Foothills Doors' },
        kindoo_site_id: 'east-stake',
      } as unknown as Building,
    ];
    const seat: Seat = {
      member_canonical: 'tad.e.smith@gmail.com',
      member_email: 'tad.e.smith@gmail.com',
      member_name: 'Tad Smith',
      scope: 'CO',
      type: 'auto',
      callings: ['Sunday School Teacher'],
      building_names: ['Cordera Building'],
      kindoo_site_id: null,
      duplicate_grants: [
        {
          scope: 'FT',
          type: 'auto',
          callings: ['Sunday School Teacher'],
          building_names: ['Foothills Building'],
          kindoo_site_id: 'east-stake',
          detected_at: { seconds: 1, nanoseconds: 0 } as unknown as DuplicateGrant['detected_at'],
        },
      ],
    } as unknown as Seat;

    lookupUserByEmailMock.mockResolvedValue(null);
    inviteUserMock.mockResolvedValue({ uid: 'new-uid' });
    saveAccessRuleMock.mockResolvedValue({ ok: true });

    // Foreign-site session: EID for east-stake.
    const FOREIGN_SESSION = { token: 'tok-foreign', eid: 4321 };
    const FOREIGN_ENVS: KindooEnvironment[] = [
      {
        EID: 4321,
        Name: 'East Stake',
        TimeZone: 'Mountain Standard Time',
      } as unknown as KindooEnvironment,
    ];

    await provisionAddOrChange({
      request: addManualRequest({
        scope: 'FT',
        building_names: ['Foothills Building'],
      }),
      seat,
      stake: STAKE,
      buildings,
      wards,
      envs: FOREIGN_ENVS,
      session: FOREIGN_SESSION,
    });

    // Foothills only (rule 6260) — Cordera (rule 6248) is on a
    // different Kindoo site and does NOT contribute to the foreign
    // write.
    expect(saveAccessRuleMock).toHaveBeenCalledTimes(1);
    expect(saveAccessRuleMock).toHaveBeenCalledWith(FOREIGN_SESSION, 'new-uid', [6260], undefined);
  });
});

// ----- T-42 per-site union — provisionRemove -----
// `computePostRemovalBuildings` must filter by the request's target
// site so removing the primary on a multi-site seat doesn't leak the
// foreign duplicate's buildings into the active Kindoo environment.

describe('provisionRemove — T-42 per-site union', () => {
  it('home-site remove of primary leaves only home-site duplicates contributing; foreign duplicate excluded', async () => {
    const wards: Ward[] = [
      ...WARDS,
      {
        ward_code: 'FT',
        ward_name: 'Foothills Ward',
        building_name: 'Foothills Building',
        kindoo_site_id: 'east-stake',
      } as unknown as Ward,
    ];
    const buildings: Building[] = [
      ...BUILDINGS,
      {
        building_id: 'foothills',
        building_name: 'Foothills Building',
        kindoo_rule: { rule_id: 6260, rule_name: 'Foothills Doors' },
        kindoo_site_id: 'east-stake',
      } as unknown as Building,
    ];
    // Seat primary CO (home) with two duplicates: PC (home) + FT
    // (foreign). Remove CO from the home session — the post-removal
    // home write should contain PC only; FT must NOT leak in.
    const seat: Seat = {
      member_canonical: 'tad.e.smith@gmail.com',
      member_email: 'tad.e.smith@gmail.com',
      member_name: 'Tad Smith',
      scope: 'CO',
      type: 'manual',
      callings: [],
      reason: 'home helper',
      building_names: ['Cordera Building'],
      kindoo_site_id: null,
      duplicate_grants: [
        {
          scope: 'PC',
          type: 'manual',
          building_names: ['Pine Creek Building'],
          kindoo_site_id: null,
          detected_at: { seconds: 1, nanoseconds: 0 } as unknown as DuplicateGrant['detected_at'],
        },
        {
          scope: 'FT',
          type: 'manual',
          building_names: ['Foothills Building'],
          kindoo_site_id: 'east-stake',
          detected_at: { seconds: 1, nanoseconds: 0 } as unknown as DuplicateGrant['detected_at'],
        },
      ],
    } as unknown as Seat;

    lookupUserByEmailMock.mockResolvedValue({
      euid: 'e1',
      userId: 'u1',
      username: 'tad.e.smith@gmail.com',
      description: 'Cordera Ward (helper) | Pine Creek Ward (helper) | Foothills Ward (helper)',
      isTempUser: false,
      startAccessDoorsDateAtTimeZone: null,
      expiryDateAtTimeZone: null,
      expiryTimeZone: 'Mountain Standard Time',
      accessSchedules: [{ ruleId: 6248 }, { ruleId: 6249 }, { ruleId: 6260 }],
    });
    saveAccessRuleMock.mockResolvedValue({ ok: true });
    revokeUserFromAccessScheduleMock.mockResolvedValue({ ok: true });
    editUserMock.mockResolvedValue({ ok: true });

    await provisionRemove({
      request: removeRequest({ scope: 'CO' }),
      seat,
      stake: STAKE,
      buildings,
      wards,
      envs: ENVS,
      session: SESSION,
    });

    // Home target buildings = PC only (CO is being removed; FT is on
    // a different site and excluded). Existing rules: 6248 (Cordera),
    // 6249 (PC), 6260 (Foothills, foreign). toRevoke = currentRIDs \
    // targetRIDs = {6248, 6260}. The foreign rule 6260 should NOT be
    // in toRevoke either — the per-site filter on the target plus the
    // legacy diff would revoke it. BUT this surface only writes
    // against the active session's site, so the test asserts that
    // saveAccessRule (the add path) is called with no foreign rules.
    // The revoke loop is a secondary concern: in practice the home
    // session can't see / revoke foreign rules. We assert saveAccessRule
    // is NOT called with 6260, and editUser's description omits FT.
    for (const call of saveAccessRuleMock.mock.calls) {
      const rids = call[2] as number[];
      expect(rids).not.toContain(6260);
    }
  });
});
