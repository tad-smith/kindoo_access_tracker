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
  };
});

// Door-grant derivation chain runs on the existing-user provision path
// to derive the TRUE buildings baseline from Kindoo (vs the SBA seat's
// recorded state). Default both calls to "succeeded with no rules
// claimed" — most existing tests pass `seat: null`, so this matches
// their pre-derivation expectations (baseline = []).
const buildRuleDoorMapMock = vi.fn();
const getUserDoorIdsMock = vi.fn();

vi.mock('./sync/buildingsFromDoors', async () => {
  const actual = await vi.importActual<typeof import('./sync/buildingsFromDoors')>(
    './sync/buildingsFromDoors',
  );
  return {
    ...actual,
    buildRuleDoorMap: (...args: unknown[]) => buildRuleDoorMapMock(...args),
    getUserDoorIds: (...args: unknown[]) => getUserDoorIdsMock(...args),
  };
});

import type { AccessRequest, Building, DuplicateGrant, Seat, Stake, Ward } from '@kindoo/shared';
import {
  provisionAddOrChange,
  provisionRemove,
  ProvisionBuildingsMissingRuleError,
  ProvisionEnvironmentNotFoundError,
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
  buildRuleDoorMapMock.mockReset();
  getUserDoorIdsMock.mockReset();
  // Default: derivation succeeds but the user claims no rules — gives
  // existing tests (which pass seat:null) the same `[]` baseline they
  // had pre-derivation.
  buildRuleDoorMapMock.mockResolvedValue(new Map());
  getUserDoorIdsMock.mockResolvedValue(new Set<number>());
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
    expect(saveAccessRuleMock).toHaveBeenCalledWith(
      SESSION,
      existing.userId,
      [6248, 6249],
      undefined,
    );
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
    expect(saveAccessRuleMock).toHaveBeenCalledWith(
      SESSION,
      existing.userId,
      [6248, 6249],
      undefined,
    );
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
    // Pine Creek being added → rule set diff.
    expect(saveAccessRuleMock).toHaveBeenCalledWith(
      SESSION,
      existing.userId,
      [6248, 6249],
      undefined,
    );
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

describe('provisionAddOrChange — Kindoo-derived baseline (door grants)', () => {
  // The existing-user branch reads each user's per-door grants and
  // strict-subset-derives the set of AccessRules they EFFECTIVELY have
  // — covers both direct grants from Church Access Automation AND
  // rule-derived grants. Then unions with the request's buildings to
  // compute targetRIDs. SBA's recorded `seat.building_names` is no
  // longer the source of truth; Kindoo's door grants are.

  it('auto user with matching Kindoo state: derivedBuildings == seat.building_names, target == derived ∪ request', async () => {
    // Seat says [Cordera, Pine Creek]; Kindoo's door grants also imply
    // [Cordera, Pine Creek] (because the user has every door in both
    // rules). Request adds nothing new (already in baseline) → no
    // saveAccessRule diff.
    const seat: Seat = {
      member_canonical: 'tad.e.smith@gmail.com',
      scope: 'stake',
      type: 'auto',
      callings: ['Bishop'],
      reason: '',
      building_names: ['Cordera Building', 'Pine Creek Building'],
      duplicate_grants: [],
    } as unknown as Seat;
    const existing = existingUser({
      description: 'Colorado Springs North Stake (Bishop)',
      accessSchedules: [{ ruleId: 6248 }, { ruleId: 6249 }],
    });
    lookupUserByEmailMock.mockResolvedValue(existing);

    buildRuleDoorMapMock.mockResolvedValue(
      new Map<number, Set<number>>([
        [6248, new Set([1, 2])],
        [6249, new Set([10, 11])],
      ]),
    );
    getUserDoorIdsMock.mockResolvedValue(new Set<number>([1, 2, 10, 11]));

    await provisionAddOrChange({
      request: addManualRequest({
        scope: 'stake',
        building_names: ['Cordera Building'], // already in baseline
      }),
      seat,
      stake: STAKE,
      buildings: BUILDINGS,
      wards: WARDS,
      envs: ENVS,
      session: SESSION,
    });

    // Baseline already covers Cordera + Pine Creek; request adds
    // nothing new; existing rules match → no saveAccessRule.
    expect(saveAccessRuleMock).not.toHaveBeenCalled();
  });

  it('auto user where Church revoked Pine Creek: target uses Kindoo-derived [Cordera] ∪ request, NOT seat [Cordera, Pine Creek]', async () => {
    // The headline behavior change. SBA seat still records both
    // buildings, but Kindoo's door grants only cover Cordera now —
    // Church silently revoked Pine Creek. Old (seat-derived) code
    // would re-grant Pine Creek; new code respects the revoke.
    const seat: Seat = {
      member_canonical: 'tad.e.smith@gmail.com',
      scope: 'stake',
      type: 'auto',
      callings: ['Bishop'],
      reason: '',
      // SBA THINKS user still has both.
      building_names: ['Cordera Building', 'Pine Creek Building'],
      duplicate_grants: [],
    } as unknown as Seat;
    // Kindoo currently only has the Cordera rule (Church revoked Pine Creek).
    const existing = existingUser({
      description: 'Colorado Springs North Stake (Bishop)',
      accessSchedules: [{ ruleId: 6248 }],
    });
    lookupUserByEmailMock.mockResolvedValue(existing);

    buildRuleDoorMapMock.mockResolvedValue(
      new Map<number, Set<number>>([
        [6248, new Set([1, 2])],
        [6249, new Set([10, 11])],
      ]),
    );
    // User holds Cordera doors only.
    getUserDoorIdsMock.mockResolvedValue(new Set<number>([1, 2]));

    // Request adds a third building (e.g. operator manually granting).
    const buildings: Building[] = [
      ...BUILDINGS.filter((b) => b.building_name !== 'Monument Building'),
      {
        building_id: 'monument',
        building_name: 'Monument Building',
        kindoo_rule: { rule_id: 6251, rule_name: 'Monument Doors' },
      } as unknown as Building,
    ];

    await provisionAddOrChange({
      request: addManualRequest({
        scope: 'stake',
        building_names: ['Monument Building'],
      }),
      seat,
      stake: STAKE,
      buildings,
      wards: WARDS,
      envs: ENVS,
      session: SESSION,
    });

    // Critical: NOT [6248, 6249, 6251] (which the old seat-derived
    // baseline would have produced). The Pine Creek rule (6249) must
    // be absent — Church already revoked it.
    expect(saveAccessRuleMock).toHaveBeenCalledWith(
      SESSION,
      existing.userId,
      [6248, 6251],
      undefined,
    );
  });

  it('manual user with rule-derived AccessSchedules: derivation matches seat → no false drift', async () => {
    // Manual users get access via AccessSchedules (no direct door
    // grants). The per-door endpoint surfaces every door the rules
    // cover; the derivation chain reconstructs the rule set. Result
    // should match the seat's recorded buildings.
    const seat: Seat = {
      member_canonical: 'tad.e.smith@gmail.com',
      scope: 'stake',
      type: 'manual',
      callings: [],
      reason: 'Sunday School Teacher',
      building_names: ['Cordera Building', 'Pine Creek Building'],
      duplicate_grants: [],
    } as unknown as Seat;
    const existing = existingUser({
      description: 'Colorado Springs North Stake (Sunday School Teacher)',
      accessSchedules: [{ ruleId: 6248 }, { ruleId: 6249 }],
    });
    lookupUserByEmailMock.mockResolvedValue(existing);

    buildRuleDoorMapMock.mockResolvedValue(
      new Map<number, Set<number>>([
        [6248, new Set([1, 2])],
        [6249, new Set([10, 11])],
      ]),
    );
    // The per-door endpoint includes every door covered by the rules
    // the user holds.
    getUserDoorIdsMock.mockResolvedValue(new Set<number>([1, 2, 10, 11]));

    await provisionAddOrChange({
      request: addManualRequest({
        scope: 'stake',
        building_names: ['Cordera Building', 'Pine Creek Building'], // matches existing
      }),
      seat,
      stake: STAKE,
      buildings: BUILDINGS,
      wards: WARDS,
      envs: ENVS,
      session: SESSION,
    });

    // Derived [Cordera, Pine Creek] ∪ request [Cordera, Pine Creek] =
    // [Cordera, Pine Creek]. Existing rules match → no saveAccessRule.
    expect(saveAccessRuleMock).not.toHaveBeenCalled();
  });

  it('derivation failure: falls back to currentSeatBuildings + logs a warn; provision still completes', async () => {
    const seat: Seat = {
      member_canonical: 'tad.e.smith@gmail.com',
      scope: 'stake',
      type: 'manual',
      callings: [],
      reason: 'Sunday School Teacher',
      building_names: ['Cordera Building'],
      duplicate_grants: [],
    } as unknown as Seat;
    const existing = existingUser({
      description: 'Colorado Springs North Stake (Sunday School Teacher)',
      accessSchedules: [{ ruleId: 6248 }],
    });
    lookupUserByEmailMock.mockResolvedValue(existing);
    saveAccessRuleMock.mockResolvedValue({ ok: true });

    // The per-door fetch blows up — extension must NOT block; it
    // should fall back to the SBA seat's recorded buildings.
    buildRuleDoorMapMock.mockRejectedValue(new Error('Kindoo down'));

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = await provisionAddOrChange({
      request: addManualRequest({
        scope: 'stake',
        building_names: ['Pine Creek Building'], // add Pine Creek
      }),
      seat,
      stake: STAKE,
      buildings: BUILDINGS,
      wards: WARDS,
      envs: ENVS,
      session: SESSION,
    });

    // Fallback baseline = seat = [Cordera] → target = [Cordera, Pine Creek].
    expect(saveAccessRuleMock).toHaveBeenCalledWith(
      SESSION,
      existing.userId,
      [6248, 6249],
      undefined,
    );
    expect(result.action).toBe('updated');
    expect(warnSpy).toHaveBeenCalled();
    const warnMsg = String(warnSpy.mock.calls[0]?.[0] ?? '');
    expect(warnMsg).toContain('[sba-ext]');
    expect(warnMsg).toContain('door-grant derivation failed');
    warnSpy.mockRestore();
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
