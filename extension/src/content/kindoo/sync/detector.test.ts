// Detector tests. Covers each DiscrepancyCode + the all-good no-emit
// path + the severity sort + the seat / kindoo counters.

import { describe, expect, it } from 'vitest';
import type { Building, Seat, Stake, Ward } from '@kindoo/shared';
import type { KindooEnvironmentUser } from '../endpoints';
import {
  detect,
  grantsBackAuto,
  isChurchBacked,
  kindooRole,
  parseKindooCallings,
} from './detector';

describe('isChurchBacked', () => {
  it('true when the member holds ANY church-direct grant', () => {
    expect(isChurchBacked(['A'])).toBe(true);
    expect(isChurchBacked(['A', 'B'])).toBe(true);
  });
  it('false when there are zero church-direct grants (all SBA-provisioned)', () => {
    expect(isChurchBacked([])).toBe(false);
  });
  it('false when directGrantBuildings is null (cannot determine)', () => {
    expect(isChurchBacked(null)).toBe(false);
  });
});

describe('grantsBackAuto', () => {
  it('true when the member holds at least one church-direct grant', () => {
    expect(grantsBackAuto(['A'])).toBe(true);
  });
  it('false when there are zero church-direct grants', () => {
    expect(grantsBackAuto([])).toBe(false);
  });
  it('false when directGrantBuildings is null', () => {
    expect(grantsBackAuto(null)).toBe(false);
  });
});

describe('parseKindooCallings', () => {
  it('returns the full comma-split calling set, preserving Kindoo casing', () => {
    expect(parseKindooCallings('Bishop, Clerk')).toEqual(['Bishop', 'Clerk']);
  });
  it('trims surrounding whitespace on each calling', () => {
    expect(parseKindooCallings(' Bishop ,  Clerk ')).toEqual(['Bishop', 'Clerk']);
  });
  it('de-dupes a calling repeated in the parens (case-insensitively, first casing wins)', () => {
    expect(parseKindooCallings('Clerk, clerk')).toEqual(['Clerk']);
  });
  it('drops empty segments', () => {
    expect(parseKindooCallings('Bishop, , ')).toEqual(['Bishop']);
  });
  it('returns [] for an empty / whitespace-only parens text', () => {
    expect(parseKindooCallings('')).toEqual([]);
    expect(parseKindooCallings('   ')).toEqual([]);
  });
});

describe('kindooRole', () => {
  const withDept = (dept: number | undefined): KindooEnvironmentUser =>
    ({
      euid: 'e',
      userId: 'u',
      username: 'x@example.com',
      description: '',
      isTempUser: false,
      startAccessDoorsDateAtTimeZone: null,
      expiryDateAtTimeZone: null,
      expiryTimeZone: '',
      accessSchedules: [],
      ...(dept !== undefined ? { DepartmentType: dept } : {}),
    }) as KindooEnvironmentUser;

  it('maps DepartmentType 0 (Administrator) to admin', () => {
    expect(kindooRole(withDept(0))).toBe('admin');
  });
  it('maps DepartmentType 1 (Manager) to admin', () => {
    expect(kindooRole(withDept(1))).toBe('admin');
  });
  it('maps DepartmentType 2 (Guest) to guest', () => {
    expect(kindooRole(withDept(2))).toBe('guest');
  });
  it('maps DepartmentType 3 (Installer) to installer', () => {
    expect(kindooRole(withDept(3))).toBe('installer');
  });
  it('treats undefined / missing DepartmentType as guest (conservative)', () => {
    expect(kindooRole(withDept(undefined))).toBe('guest');
  });
  it('treats any other concrete number as admin (force-auto)', () => {
    expect(kindooRole(withDept(9))).toBe('admin');
  });
});

function ts(): Ward['created_at'] {
  return {
    seconds: 0,
    nanoseconds: 0,
    toDate: () => new Date(0),
    toMillis: () => 0,
  };
}

function stake(overrides: Partial<Stake> = {}): Stake {
  return {
    stake_id: 'csnorth',
    stake_name: 'Colorado Springs North Stake',
    created_at: ts(),
    created_by: 'admin@csnorth.org',
    bootstrap_admin_email: 'admin@csnorth.org',
    setup_complete: true,
    stake_seat_cap: 250,
    timezone: 'America/Denver',
    notifications_enabled: true,
    last_over_caps_json: [],
    last_modified_at: ts(),
    last_modified_by: { email: 'sys@example.com', canonical: 'sys@example.com' },
    lastActor: { email: 'sys@example.com', canonical: 'sys@example.com' },
    ...overrides,
  };
}

function ward(code: string, name: string, building: string): Ward {
  return {
    ward_code: code,
    ward_name: name,
    building_name: building,
    seat_cap: 30,
    created_at: ts(),
    last_modified_at: ts(),
    lastActor: { email: 'sys@example.com', canonical: 'sys@example.com' },
  };
}

function building(
  id: string,
  name: string,
  ruleId: number | null,
  kindooSiteId: string | null = null,
): Building {
  return {
    building_id: id,
    building_name: name,
    address: '123 Main',
    kindoo_site_id: kindooSiteId,
    ...(ruleId !== null ? { kindoo_rule: { rule_id: ruleId, rule_name: `${name} Doors` } } : {}),
    created_at: ts(),
    last_modified_at: ts(),
    lastActor: { email: 'sys@example.com', canonical: 'sys@example.com' },
  };
}

function seat(overrides: Partial<Seat>): Seat {
  return {
    member_canonical: 'someone@example.com',
    member_email: 'someone@example.com',
    member_name: 'Someone',
    scope: 'CO',
    type: 'auto',
    callings: ['Sunday School Teacher'],
    building_names: ['Maple Building'],
    duplicate_grants: [],
    created_at: ts(),
    last_modified_at: ts(),
    last_modified_by: { email: 'sys@example.com', canonical: 'sys@example.com' },
    lastActor: { email: 'sys@example.com', canonical: 'sys@example.com' },
    ...overrides,
  };
}

function kuser(overrides: Partial<KindooEnvironmentUser>): KindooEnvironmentUser {
  return {
    euid: 'e1',
    userId: 'u1',
    username: 'someone@example.com',
    description: 'Maple Ward (Sunday School Teacher)',
    isTempUser: false,
    startAccessDoorsDateAtTimeZone: null,
    expiryDateAtTimeZone: null,
    expiryTimeZone: 'Mountain Standard Time',
    accessSchedules: [{ ruleId: 6248 }],
    // Default to Guest (DepartmentType 2) so the base fixture exercises
    // the grant-based classification path (#188); role-branch tests
    // override this explicitly.
    DepartmentType: 2,
    ...overrides,
  };
}

/**
 * A kuser with NO `DepartmentType` at all (the field is absent, not
 * `undefined`-valued — `exactOptionalPropertyTypes` forbids passing the
 * literal `undefined`). Exercises the detector's "missing role →
 * conservative Guest" path.
 */
function kuserNoRole(overrides: Partial<KindooEnvironmentUser>): KindooEnvironmentUser {
  const u = kuser(overrides);
  delete u.DepartmentType;
  return u;
}

const STAKE = stake();
const WARDS = [
  ward('CO', 'Maple Ward', 'Maple Building'),
  ward('PC', 'Pine Creek Ward', 'Pine Creek Building'),
];
const BUILDINGS = [
  building('maple', 'Maple Building', 6248),
  building('pinecreek', 'Pine Creek Building', 6249),
];

function baseInputs(overrides: { seats?: Seat[]; kindooUsers?: KindooEnvironmentUser[] }) {
  return {
    stake: STAKE,
    wards: WARDS,
    buildings: BUILDINGS,
    seats: overrides.seats ?? [],
    kindooUsers: overrides.kindooUsers ?? [],
  };
}

describe('detect', () => {
  it('emits no row when seat and Kindoo user agree fully', () => {
    const result = detect(
      baseInputs({
        seats: [seat({})],
        kindooUsers: [kuser({})],
      }),
    );
    expect(result.discrepancies).toEqual([]);
    expect(result.seatCount).toBe(1);
    expect(result.kindooCount).toBe(1);
  });

  it('emits sba-only when seat exists but no Kindoo user', () => {
    const result = detect(baseInputs({ seats: [seat({})], kindooUsers: [] }));
    expect(result.discrepancies).toHaveLength(1);
    const row = result.discrepancies[0]!;
    expect(row.code).toBe('sba-only');
    expect(row.severity).toBe('drift');
    expect(row.sba).not.toBeNull();
    expect(row.kindoo).toBeNull();
  });

  it('emits kindoo-only when Kindoo user exists but no SBA seat', () => {
    const result = detect(baseInputs({ kindooUsers: [kuser({})] }));
    expect(result.discrepancies).toHaveLength(1);
    expect(result.discrepancies[0]?.code).toBe('kindoo-only');
    expect(result.discrepancies[0]?.severity).toBe('drift');
    expect(result.discrepancies[0]?.sba).toBeNull();
    expect(result.discrepancies[0]?.kindoo).not.toBeNull();
  });

  it('kindoo-only carries grantTargetType=auto when the user is church-backed', () => {
    // The created seat would carry derivedBuildings=[Maple], and every
    // one of those is direct-granted → church-backed → auto.
    const result = detect(
      baseInputs({
        kindooUsers: [
          kuser({
            derivedBuildings: ['Maple Building'],
            directGrantBuildings: ['Maple Building'],
          }),
        ],
      }),
    );
    expect(result.discrepancies[0]?.code).toBe('kindoo-only');
    expect(result.discrepancies[0]?.kindoo?.grantTargetType).toBe('auto');
  });

  it('kindoo-only carries grantTargetType=manual when the user is not church-backed', () => {
    // Effective access exists (derivedBuildings=[Maple]) but not via a
    // direct grant → not church-backed → manual.
    const result = detect(
      baseInputs({
        kindooUsers: [
          kuser({
            description: 'Maple Ward (Building Greeter)',
            derivedBuildings: ['Maple Building'],
            directGrantBuildings: [],
          }),
        ],
      }),
    );
    expect(result.discrepancies[0]?.code).toBe('kindoo-only');
    expect(result.discrepancies[0]?.kindoo?.grantTargetType).toBe('manual');
  });

  it('kindoo-only carries grantTargetType=manual when door derivation failed (null)', () => {
    const result = detect(
      baseInputs({
        kindooUsers: [
          kuser({
            description: 'Maple Ward (Building Greeter)',
            derivedBuildings: null,
            directGrantBuildings: null,
          }),
        ],
      }),
    );
    expect(result.discrepancies[0]?.code).toBe('kindoo-only');
    expect(result.discrepancies[0]?.kindoo?.grantTargetType).toBe('manual');
  });

  it('kindoo-only carries grantTargetType=temp for an IsTempUser regardless of grants', () => {
    const result = detect(
      baseInputs({
        kindooUsers: [
          kuser({
            isTempUser: true,
            description: 'Maple Ward (Visiting speaker)',
            derivedBuildings: ['Maple Building'],
            directGrantBuildings: ['Maple Building'],
          }),
        ],
      }),
    );
    expect(result.discrepancies[0]?.code).toBe('kindoo-only');
    expect(result.discrepancies[0]?.kindoo?.grantTargetType).toBe('temp');
  });

  it('kindoo-only with ZERO door grants is born manual, not vacuously auto', () => {
    // A Kindoo user that exists in the env list but holds no doors
    // (newly added, access revoked) derives to empty building sets.
    // grantsBackAuto requires ≥1 building, so the created seat is manual
    // — never an empty-building auto seat.
    const result = detect(
      baseInputs({
        kindooUsers: [
          kuser({
            description: 'Maple Ward (Building Greeter)',
            accessSchedules: [],
            derivedBuildings: [],
            directGrantBuildings: [],
          }),
        ],
      }),
    );
    expect(result.discrepancies[0]?.code).toBe('kindoo-only');
    expect(result.discrepancies[0]?.kindoo?.grantTargetType).toBe('manual');
  });

  it('emits kindoo-unparseable (drift) for a present-but-unparseable description', () => {
    // Text present but doesn't match `Scope (Calling)` — treat as a
    // church-wide stake-scope calling; Update SBA offered, so drift. Seat
    // is at ward scope (not aligned), so the row stands. The Guest gate is
    // gone: this applies to every seat role.
    const result = detect(
      baseInputs({
        seats: [seat({})],
        kindooUsers: [kuser({ description: 'Some Church-Wide Calling' })],
      }),
    );
    expect(result.discrepancies).toHaveLength(1);
    expect(result.discrepancies[0]?.code).toBe('kindoo-unparseable');
    expect(result.discrepancies[0]?.severity).toBe('drift');
    // The kindoo block stays populated so the dispatcher can read the raw
    // description.
    expect(result.discrepancies[0]?.kindoo?.description).toBe('Some Church-Wide Calling');
  });

  it('emits kindoo-unparseable (drift) for a Kindoo Manager present-but-unparseable', () => {
    // A Kindoo Manager who also holds an SBA seat: with the Guest gate
    // removed, this is an actionable drift (Update SBA), the same as any
    // other seat role. Managers can hold seats too.
    const result = detect(
      baseInputs({
        seats: [seat({})],
        kindooUsers: [kuser({ description: 'Kindoo Manager - Stake Clerk' })],
      }),
    );
    expect(result.discrepancies).toHaveLength(1);
    expect(result.discrepancies[0]?.code).toBe('kindoo-unparseable');
    expect(result.discrepancies[0]?.severity).toBe('drift');
  });

  it('suppresses kindoo-unparseable entirely on a foreign Kindoo site (A)', () => {
    // Operator contract: "apply to stake scope" is a home/stake concept;
    // a foreign active site never surfaces a kindoo-unparseable row. The
    // home-site gate enforces this even with an unaligned seat (and the
    // foreign-site user filter independently drops unresolved descriptions
    // — belt and suspenders).
    const result = detect({
      ...mixedInputs({
        seats: [seat({ member_canonical: 'fa@example.com', member_email: 'fa@example.com' })],
        kindooUsers: [
          kuser({
            username: 'fa@example.com',
            description: 'Some Church-Wide Calling',
          }),
        ],
        activeSite: { kind: 'foreign', siteId: 'east-stake' },
      }),
    });
    expect(result.discrepancies.filter((d) => d.code === 'kindoo-unparseable')).toEqual([]);
  });

  it('home-site present-but-unparseable: drift when seat NOT aligned, suppressed when aligned (B)', () => {
    // Not aligned — seat still at ward scope → actionable drift row.
    const notAligned = detect({
      ...baseInputs({
        seats: [seat({ scope: 'CO', type: 'auto', callings: ['Sunday School Teacher'] })],
        kindooUsers: [kuser({ description: 'Some Church-Wide Calling' })],
      }),
      activeSite: { kind: 'home' },
    });
    expect(notAligned.discrepancies).toHaveLength(1);
    expect(notAligned.discrepancies[0]?.code).toBe('kindoo-unparseable');
    expect(notAligned.discrepancies[0]?.severity).toBe('drift');

    // Aligned (auto): stake scope + callings === [rawDescription] → no row.
    const alignedAuto = detect({
      ...baseInputs({
        seats: [seat({ scope: 'stake', type: 'auto', callings: ['Some Church-Wide Calling'] })],
        kindooUsers: [kuser({ description: 'Some Church-Wide Calling' })],
      }),
      activeSite: { kind: 'home' },
    });
    expect(alignedAuto.discrepancies).toEqual([]);

    // Aligned (manual): stake scope + reason === rawDescription, callings
    // empty → no row. Case/whitespace-insensitive.
    const alignedManual = detect({
      ...baseInputs({
        seats: [
          seat({
            scope: 'stake',
            type: 'manual',
            callings: [],
            reason: 'some church-wide calling',
          }),
        ],
        kindooUsers: [kuser({ description: '  Some Church-Wide Calling  ' })],
      }),
      activeSite: { kind: 'home' },
    });
    expect(alignedManual.discrepancies).toEqual([]);
  });

  it('emits kindoo-no-description (review) on a blank Kindoo description', () => {
    // Blank description (no segments) — nothing to reconcile; the one
    // remaining review-only code, no SBA-side action.
    const result = detect(
      baseInputs({
        seats: [seat({})],
        kindooUsers: [kuser({ description: '' })],
      }),
    );
    expect(result.discrepancies).toHaveLength(1);
    expect(result.discrepancies[0]?.code).toBe('kindoo-no-description');
    expect(result.discrepancies[0]?.severity).toBe('review');
  });

  it('emits scope-mismatch when parsed primary differs from seat.scope', () => {
    const result = detect(
      baseInputs({
        seats: [seat({ scope: 'CO' })],
        kindooUsers: [
          kuser({
            description: 'Pine Creek Ward (Sunday School Teacher)',
            accessSchedules: [{ ruleId: 6249 }],
          }),
        ],
      }),
    );
    expect(result.discrepancies).toHaveLength(1);
    expect(result.discrepancies[0]?.code).toBe('scope-mismatch');
  });

  it('promotes manual → auto (type-mismatch) when the seat is church-backed via direct grants', () => {
    // Grant-based promote: a manual seat whose building doors are all
    // direct-granted by Church Access Automation. The church owns
    // provisioning ⇒ auto. The target type rides on the KindooBlock as
    // `grantTargetType`.
    const result = detect(
      baseInputs({
        seats: [
          seat({
            scope: 'CO',
            type: 'manual',
            callings: [],
            reason: 'Sunday School Teacher',
            building_names: ['Maple Building'],
          }),
        ],
        kindooUsers: [
          kuser({
            description: 'Maple Ward (Sunday School Teacher)',
            derivedBuildings: ['Maple Building'],
            directGrantBuildings: ['Maple Building'],
          }),
        ],
      }),
    );
    expect(result.discrepancies).toHaveLength(1);
    const row = result.discrepancies[0]!;
    expect(row.code).toBe('type-mismatch');
    expect(row.kindoo?.grantTargetType).toBe('auto');
    expect(row.reason).toContain('Promote to auto');
  });

  it('demotes auto → manual (type-mismatch) when the seat is no longer church-backed', () => {
    // Grant-based demote: an auto seat whose direct grants no longer
    // cover all of its building doors (the church removed access). SBA
    // must own the grant ⇒ manual.
    const result = detect(
      baseInputs({
        seats: [
          seat({
            scope: 'CO',
            type: 'auto',
            callings: ['Sunday School Teacher'],
            building_names: ['Maple Building'],
          }),
        ],
        kindooUsers: [
          kuser({
            description: 'Maple Ward (Sunday School Teacher)',
            // Effective access still present (rule-derived), but NOT via
            // a direct grant — so demote fires.
            derivedBuildings: ['Maple Building'],
            directGrantBuildings: [],
          }),
        ],
      }),
    );
    expect(result.discrepancies).toHaveLength(1);
    const row = result.discrepancies[0]!;
    expect(row.code).toBe('type-mismatch');
    expect(row.kindoo?.grantTargetType).toBe('manual');
    expect(row.reason).toContain('Demote to manual');
  });

  it('promotes a Guest with a PARTIAL church grant (some church doors + some SBA) to auto', () => {
    // New "any church-direct grant" rule: the seat spans two buildings;
    // only ONE is church-direct-granted. The seat-building-subset rule
    // would have left this manual — now a single church grant promotes
    // it to auto. (Building coverage still drives buildings-mismatch, not
    // the type decision.)
    const result = detect(
      baseInputs({
        seats: [
          seat({
            scope: 'stake',
            type: 'manual',
            callings: [],
            reason: 'Stake Clerk',
            building_names: ['Maple Building', 'Pine Creek Building'],
          }),
        ],
        kindooUsers: [
          kuser({
            description: 'Colorado Springs North Stake (Stake Clerk)',
            derivedBuildings: ['Maple Building', 'Pine Creek Building'],
            // Only Maple is church-direct; Pine Creek is SBA-provisioned.
            directGrantBuildings: ['Maple Building'],
          }),
        ],
      }),
    );
    const typeRows = result.discrepancies.filter((d) => d.code === 'type-mismatch');
    expect(typeRows).toHaveLength(1);
    expect(typeRows[0]?.kindoo?.grantTargetType).toBe('auto');
    expect(typeRows[0]?.reason).toContain('Promote to auto');
  });

  it('keeps an auto Guest seat auto when it holds at least one church-direct grant (no demote)', () => {
    // The seat building set is NOT fully church-direct (only Maple is),
    // but ≥1 church grant means the church still provisions ⇒ stays auto.
    const result = detect(
      baseInputs({
        seats: [
          seat({
            scope: 'stake',
            type: 'auto',
            callings: ['Stake Clerk'],
            building_names: ['Maple Building', 'Pine Creek Building'],
          }),
        ],
        kindooUsers: [
          kuser({
            description: 'Colorado Springs North Stake (Stake Clerk)',
            derivedBuildings: ['Maple Building', 'Pine Creek Building'],
            directGrantBuildings: ['Maple Building'],
          }),
        ],
      }),
    );
    expect(result.discrepancies.filter((d) => d.code === 'type-mismatch')).toEqual([]);
  });

  it('demotes a Guest auto seat with ZERO church-direct grants to manual', () => {
    // All access is SBA-rule-provisioned (directGrantBuildings=[]) → no
    // church grant → demote to manual.
    const result = detect(
      baseInputs({
        seats: [
          seat({
            scope: 'CO',
            type: 'auto',
            callings: ['Sunday School Teacher'],
            building_names: ['Maple Building'],
          }),
        ],
        kindooUsers: [
          kuser({
            description: 'Maple Ward (Sunday School Teacher)',
            derivedBuildings: ['Maple Building'],
            directGrantBuildings: [],
          }),
        ],
      }),
    );
    const typeRows = result.discrepancies.filter((d) => d.code === 'type-mismatch');
    expect(typeRows).toHaveLength(1);
    expect(typeRows[0]?.kindoo?.grantTargetType).toBe('manual');
    expect(typeRows[0]?.reason).toContain('Demote to manual');
  });

  it('does not promote/demote when directGrantBuildings is null (cannot determine)', () => {
    // Derivation failed → directGrantBuildings null → skip the type
    // decision entirely, same fallback as the buildings-null skip.
    const result = detect(
      baseInputs({
        seats: [
          seat({
            scope: 'CO',
            type: 'manual',
            callings: [],
            reason: 'Sunday School Teacher',
            building_names: ['Maple Building'],
          }),
        ],
        kindooUsers: [
          kuser({
            description: 'Maple Ward (Sunday School Teacher)',
            derivedBuildings: ['Maple Building'],
            directGrantBuildings: null,
          }),
        ],
      }),
    );
    const typeRows = result.discrepancies.filter((d) => d.code === 'type-mismatch');
    expect(typeRows).toEqual([]);
  });

  it('does not fire type-mismatch when the seat type already agrees with grants', () => {
    // auto seat that IS church-backed → no demote; manual seat that is
    // NOT church-backed → no promote. Neither fires.
    const churchBackedAuto = detect(
      baseInputs({
        seats: [
          seat({
            member_canonical: 'auto-ok@example.com',
            member_email: 'auto-ok@example.com',
            scope: 'CO',
            type: 'auto',
            callings: ['Sunday School Teacher'],
            building_names: ['Maple Building'],
          }),
        ],
        kindooUsers: [
          kuser({
            username: 'auto-ok@example.com',
            description: 'Maple Ward (Sunday School Teacher)',
            derivedBuildings: ['Maple Building'],
            directGrantBuildings: ['Maple Building'],
          }),
        ],
      }),
    );
    expect(churchBackedAuto.discrepancies.filter((d) => d.code === 'type-mismatch')).toEqual([]);

    const manualNotBacked = detect(
      baseInputs({
        seats: [
          seat({
            member_canonical: 'manual-ok@example.com',
            member_email: 'manual-ok@example.com',
            scope: 'CO',
            type: 'manual',
            callings: [],
            reason: 'Building Greeter',
            building_names: ['Maple Building'],
          }),
        ],
        kindooUsers: [
          kuser({
            username: 'manual-ok@example.com',
            description: 'Maple Ward (Building Greeter)',
            derivedBuildings: ['Maple Building'],
            directGrantBuildings: [],
          }),
        ],
      }),
    );
    expect(manualNotBacked.discrepancies.filter((d) => d.code === 'type-mismatch')).toEqual([]);
  });

  it('never promotes/demotes a temp seat (temp is IsTempUser-driven)', () => {
    // A temp seat whose doors are fully direct-granted must NOT promote
    // to auto — temp is orthogonal to grant provenance.
    const result = detect(
      baseInputs({
        seats: [
          seat({
            scope: 'CO',
            type: 'temp',
            callings: [],
            reason: 'Visiting speaker',
            building_names: ['Maple Building'],
          }),
        ],
        kindooUsers: [
          kuser({
            isTempUser: true,
            description: 'Maple Ward (Visiting speaker)',
            derivedBuildings: ['Maple Building'],
            directGrantBuildings: ['Maple Building'],
          }),
        ],
      }),
    );
    expect(result.discrepancies.filter((d) => d.code === 'type-mismatch')).toEqual([]);
  });

  it('demotes a Kindoo Manager auto seat that is no longer church-backed (gate removed)', () => {
    // Staging repro shape (placeholder email/name): a Kindoo Manager
    // whose Description parses cleanly (stake-scope, Stake Clerk) and
    // matches an auto SBA seat. With the Guest gate removed, grant
    // reconciliation applies to managers too: the seat's buildings are not
    // direct-granted (directGrantBuildings=[]) → DEMOTE to manual fires.
    // The demote short-circuits before the buildings check (one row).
    const result = detect(
      baseInputs({
        seats: [
          seat({
            scope: 'stake',
            type: 'auto',
            callings: ['Stake Clerk'],
            building_names: ['Maple Building', 'Pine Creek Building'],
          }),
        ],
        kindooUsers: [
          kuser({
            description: 'Colorado Springs North Stake (Stake Clerk)',
            accessSchedules: [],
            derivedBuildings: [],
            directGrantBuildings: [],
          }),
        ],
      }),
    );
    expect(result.discrepancies).toHaveLength(1);
    const row = result.discrepancies[0]!;
    expect(row.code).toBe('type-mismatch');
    expect(row.kindoo?.grantTargetType).toBe('manual');
  });

  it('reconciles a user that HAS door grants regardless of seat role', () => {
    // A user that holds rule-derived doors but no direct grants
    // (directGrantBuildings=[]) under an auto seat → DEMOTE to manual.
    // Previously a non-Guest here was skipped by the role gate; now it
    // reconciles like any other seat.
    const result = detect(
      baseInputs({
        seats: [
          seat({
            scope: 'CO',
            type: 'auto',
            callings: ['Sunday School Teacher'],
            building_names: ['Maple Building'],
          }),
        ],
        kindooUsers: [
          kuser({
            description: 'Maple Ward (Sunday School Teacher)',
            derivedBuildings: ['Maple Building'],
            directGrantBuildings: [],
          }),
        ],
      }),
    );
    expect(result.discrepancies).toHaveLength(1);
    const row = result.discrepancies[0]!;
    expect(row.code).toBe('type-mismatch');
    expect(row.kindoo?.grantTargetType).toBe('manual');
  });

  it('demotes an auto seat with shrunk grants', () => {
    // A user still holds rule-derived doors (derivedBuildings=[Maple]) but
    // they are no longer direct-granted (directGrantBuildings=[]) → the
    // church stopped owning the seat → demote fires.
    const result = detect(
      baseInputs({
        seats: [
          seat({
            scope: 'CO',
            type: 'auto',
            callings: ['Sunday School Teacher'],
            building_names: ['Maple Building'],
          }),
        ],
        kindooUsers: [
          kuser({
            description: 'Maple Ward (Sunday School Teacher)',
            derivedBuildings: ['Maple Building'],
            directGrantBuildings: [],
          }),
        ],
      }),
    );
    expect(result.discrepancies).toHaveLength(1);
    const row = result.discrepancies[0]!;
    expect(row.code).toBe('type-mismatch');
    expect(row.kindoo?.grantTargetType).toBe('manual');
  });

  it('demotes an auto seat whose church access was ENTIRELY revoked (zero door rows)', () => {
    // gossbc-style fix: a user with zero door rows reads derivedBuildings
    // / directGrantBuildings as []. Direct grants are KNOWN (empty), so the
    // auto seat is no longer church-backed → DEMOTE. Previously the
    // role-from-door-rows gate skipped this (role unreadable); the gate is
    // gone, so the demote fires.
    const result = detect(
      baseInputs({
        seats: [
          seat({
            scope: 'CO',
            type: 'auto',
            callings: ['Sunday School Teacher'],
            building_names: ['Maple Building'],
          }),
        ],
        kindooUsers: [
          kuser({
            description: 'Maple Ward (Sunday School Teacher)',
            derivedBuildings: [],
            directGrantBuildings: [],
          }),
        ],
      }),
    );
    expect(result.discrepancies).toHaveLength(1);
    const row = result.discrepancies[0]!;
    expect(row.code).toBe('type-mismatch');
    expect(row.kindoo?.grantTargetType).toBe('manual');
  });

  it('skips a fetch-failure (null) auto seat — derivation null (per-check null safety)', () => {
    // The per-user door fetch FAILED (derivedBuildings /
    // directGrantBuildings null). The per-check null guards skip both the
    // promote/demote (directGrantBuildings null) and the auto
    // buildings-mismatch (derivedBuildings null) — no row. This safety is
    // unchanged by the gate removal.
    const result = detect(
      baseInputs({
        seats: [
          seat({
            scope: 'CO',
            type: 'auto',
            callings: ['Sunday School Teacher'],
            building_names: ['Maple Building'],
          }),
        ],
        kindooUsers: [
          kuser({
            description: 'Maple Ward (Sunday School Teacher)',
            derivedBuildings: null,
            directGrantBuildings: null,
          }),
        ],
      }),
    );
    expect(result.discrepancies).toEqual([]);
  });

  // ----- Kindoo role (DepartmentType) branch -----

  it('admin (DepartmentType 0) kindoo-only is born auto regardless of grant backing', () => {
    // An Administrator with NO direct grants (directGrantBuildings=[]).
    // A Guest here would be born manual; an admin forces auto.
    const result = detect(
      baseInputs({
        kindooUsers: [
          kuser({
            DepartmentType: 0,
            description: 'Maple Ward (Building Greeter)',
            derivedBuildings: ['Maple Building'],
            directGrantBuildings: [],
          }),
        ],
      }),
    );
    expect(result.discrepancies[0]?.code).toBe('kindoo-only');
    expect(result.discrepancies[0]?.kindoo?.grantTargetType).toBe('auto');
  });

  it('admin (DepartmentType 1, Manager) kindoo-only is born auto regardless of grant backing', () => {
    const result = detect(
      baseInputs({
        kindooUsers: [
          kuser({
            DepartmentType: 1,
            description: 'Maple Ward (Building Greeter)',
            derivedBuildings: [],
            directGrantBuildings: [],
          }),
        ],
      }),
    );
    expect(result.discrepancies[0]?.code).toBe('kindoo-only');
    expect(result.discrepancies[0]?.kindoo?.grantTargetType).toBe('auto');
  });

  it('admin kindoo-only that is also a temp user stays temp (temp wins over force-auto)', () => {
    const result = detect(
      baseInputs({
        kindooUsers: [
          kuser({
            DepartmentType: 0,
            isTempUser: true,
            description: 'Maple Ward (Visiting speaker)',
            derivedBuildings: [],
            directGrantBuildings: [],
          }),
        ],
      }),
    );
    expect(result.discrepancies[0]?.code).toBe('kindoo-only');
    expect(result.discrepancies[0]?.kindoo?.grantTargetType).toBe('temp');
  });

  it('admin with an existing MANUAL seat emits type-mismatch PROMOTE to auto', () => {
    // No direct grants — a Guest would NOT promote here; the admin role
    // forces auto independent of grant backing.
    const result = detect(
      baseInputs({
        seats: [
          seat({
            scope: 'CO',
            type: 'manual',
            callings: [],
            reason: 'Building Greeter',
            building_names: ['Maple Building'],
          }),
        ],
        kindooUsers: [
          kuser({
            DepartmentType: 0,
            description: 'Maple Ward (Building Greeter)',
            derivedBuildings: ['Maple Building'],
            directGrantBuildings: [],
          }),
        ],
      }),
    );
    const typeRows = result.discrepancies.filter((d) => d.code === 'type-mismatch');
    expect(typeRows).toHaveLength(1);
    expect(typeRows[0]?.kindoo?.grantTargetType).toBe('auto');
    expect(typeRows[0]?.reason).toContain('Promote to auto');
  });

  it('admin with an existing AUTO seat emits NO type-mismatch row', () => {
    // Even with zero direct grants — a Guest auto seat here would DEMOTE;
    // the admin stays auto, so no type-mismatch.
    const result = detect(
      baseInputs({
        seats: [
          seat({
            scope: 'CO',
            type: 'auto',
            callings: ['Sunday School Teacher'],
            building_names: ['Maple Building'],
          }),
        ],
        kindooUsers: [
          kuser({
            DepartmentType: 1,
            description: 'Maple Ward (Sunday School Teacher)',
            derivedBuildings: ['Maple Building'],
            directGrantBuildings: [],
          }),
        ],
      }),
    );
    expect(result.discrepancies.filter((d) => d.code === 'type-mismatch')).toEqual([]);
  });

  it('admin never bypasses temp — a temp seat is not promoted to auto', () => {
    const result = detect(
      baseInputs({
        seats: [
          seat({
            scope: 'CO',
            type: 'temp',
            callings: [],
            reason: 'Visiting speaker',
            building_names: ['Maple Building'],
          }),
        ],
        kindooUsers: [
          kuser({
            DepartmentType: 0,
            isTempUser: true,
            description: 'Maple Ward (Visiting speaker)',
            derivedBuildings: ['Maple Building'],
            directGrantBuildings: ['Maple Building'],
          }),
        ],
      }),
    );
    expect(result.discrepancies.filter((d) => d.code === 'type-mismatch')).toEqual([]);
  });

  it('admin with an UNPARSEABLE description on an aligned-stake MANUAL seat still PROMOTEs to auto (hoist)', () => {
    // The gap the reviewer found: a Manager carries an unparseable
    // description, and the seat is ALREADY at the unparseable-aligned
    // stake state (scope='stake', type='manual', reason===description,
    // callings empty). The unparseable-aligned short-circuit would
    // suppress the row — so the admin force-auto MUST run before it. With
    // the hoist, the seat promotes to auto.
    const result = detect(
      baseInputs({
        seats: [
          seat({
            scope: 'stake',
            type: 'manual',
            callings: [],
            reason: 'Manager Service Account',
            building_names: ['Maple Building'],
          }),
        ],
        kindooUsers: [
          kuser({
            DepartmentType: 1,
            // Unparseable: text present but no `Scope (Calling)` form. Seat
            // reason mirrors it, so the seat is unparseable-aligned.
            description: 'Manager Service Account',
            derivedBuildings: [],
            directGrantBuildings: [],
          }),
        ],
      }),
    );
    expect(result.discrepancies).toHaveLength(1);
    const row = result.discrepancies[0]!;
    expect(row.code).toBe('type-mismatch');
    expect(row.kindoo?.grantTargetType).toBe('auto');
    expect(row.reason).toContain('Promote to auto');
  });

  it('already-auto admin with an unaligned UNPARSEABLE description still falls through to kindoo-unparseable', () => {
    // An already-auto admin is NOT short-circuited by the hoist (it only
    // fires for non-auto, non-temp). So an auto admin seat at ward scope
    // with an unparseable description still surfaces the
    // `kindoo-unparseable → stake` drift row.
    const result = detect(
      baseInputs({
        seats: [
          seat({
            scope: 'CO',
            type: 'auto',
            callings: ['Sunday School Teacher'],
            building_names: ['Maple Building'],
          }),
        ],
        kindooUsers: [
          kuser({
            DepartmentType: 1,
            description: 'Manager Service Account',
            derivedBuildings: ['Maple Building'],
            directGrantBuildings: ['Maple Building'],
          }),
        ],
      }),
    );
    expect(result.discrepancies).toHaveLength(1);
    const row = result.discrepancies[0]!;
    expect(row.code).toBe('kindoo-unparseable');
    expect(row.severity).toBe('drift');
  });

  it('installer (DepartmentType 3) kindoo-only emits NO row', () => {
    const result = detect(
      baseInputs({
        kindooUsers: [
          kuser({
            DepartmentType: 3,
            username: 'ryan.gard@example.com',
            description: 'Maple Ward (Sunday School Teacher)',
            derivedBuildings: ['Maple Building'],
            directGrantBuildings: ['Maple Building'],
          }),
        ],
      }),
    );
    expect(result.discrepancies).toEqual([]);
    // Counter still reflects the user existed in the listing.
    expect(result.kindooCount).toBe(1);
  });

  it('installer emits NO row even with an unparseable description', () => {
    const result = detect(
      baseInputs({
        kindooUsers: [
          kuser({
            DepartmentType: 3,
            username: 'greagmills@example.com',
            description: 'Some Church-Wide Calling',
          }),
        ],
      }),
    );
    expect(result.discrepancies).toEqual([]);
  });

  it('installer emits NO row even when it differs from an existing SBA seat', () => {
    // Both sides present and the Kindoo door truth differs from the seat;
    // a Guest here would fire buildings-mismatch. The installer suppresses
    // every code.
    const result = detect(
      baseInputs({
        seats: [
          seat({
            member_canonical: 'inst@example.com',
            member_email: 'inst@example.com',
            scope: 'CO',
            type: 'auto',
            callings: ['Sunday School Teacher'],
            building_names: ['Maple Building'],
          }),
        ],
        kindooUsers: [
          kuser({
            DepartmentType: 3,
            username: 'inst@example.com',
            description: 'Maple Ward (Sunday School Teacher)',
            derivedBuildings: ['Maple Building', 'Pine Creek Building'],
            directGrantBuildings: ['Maple Building'],
          }),
        ],
      }),
    );
    expect(result.discrepancies).toEqual([]);
  });

  it('undefined DepartmentType is treated as Guest (grant-based, not auto/skip)', () => {
    // No DepartmentType → conservative Guest path: an auto seat with no
    // direct grants DEMOTEs to manual (the Guest grant-based behavior),
    // proving the user was neither force-auto'd nor skipped.
    const result = detect(
      baseInputs({
        seats: [
          seat({
            scope: 'CO',
            type: 'auto',
            callings: ['Sunday School Teacher'],
            building_names: ['Maple Building'],
          }),
        ],
        kindooUsers: [
          kuserNoRole({
            description: 'Maple Ward (Sunday School Teacher)',
            derivedBuildings: ['Maple Building'],
            directGrantBuildings: [],
          }),
        ],
      }),
    );
    const typeRows = result.discrepancies.filter((d) => d.code === 'type-mismatch');
    expect(typeRows).toHaveLength(1);
    expect(typeRows[0]?.kindoo?.grantTargetType).toBe('manual');
  });

  it('emits buildings-mismatch when doors differ from the SBA seat (seat stays auto)', () => {
    // The seat building [Maple] is fully direct-granted so the seat stays
    // auto (no demote preempts), but the Kindoo door truth
    // (derivedBuildings=[Maple, Pine Creek]) carries an extra building →
    // buildings-mismatch.
    const result = detect(
      baseInputs({
        seats: [
          seat({
            scope: 'CO',
            type: 'auto',
            callings: ['Sunday School Teacher'],
            building_names: ['Maple Building'],
          }),
        ],
        kindooUsers: [
          kuser({
            description: 'Maple Ward (Sunday School Teacher)',
            derivedBuildings: ['Maple Building', 'Pine Creek Building'],
            directGrantBuildings: ['Maple Building'],
          }),
        ],
      }),
    );
    expect(result.discrepancies).toHaveLength(1);
    expect(result.discrepancies[0]?.code).toBe('buildings-mismatch');
  });

  it('emits buildings-mismatch when manual seat rule set vs SBA building set differs', () => {
    const result = detect(
      baseInputs({
        seats: [
          seat({
            type: 'manual',
            callings: [],
            reason: 'Requested by bishop',
            building_names: ['Maple Building', 'Pine Creek Building'],
          }),
        ],
        kindooUsers: [
          kuser({
            description: 'Maple Ward (Building Greeter)',
            accessSchedules: [{ ruleId: 6248 }],
          }),
        ],
      }),
    );
    expect(result.discrepancies).toHaveLength(1);
    expect(result.discrepancies[0]?.code).toBe('buildings-mismatch');
  });

  it('skips buildings comparison for auto seats when derivedBuildings is null (Phase 1 fallback)', () => {
    // Auto-imported users receive door access via direct door grants
    // (Church Access Automation), which the bulk listing's
    // AccessSchedules array does not expose. When per-user door-grant
    // derivation fails or is skipped (`derivedBuildings === null`),
    // the detector falls back to the original Phase 1 behaviour and
    // does not emit a buildings-mismatch row.
    const result = detect(
      baseInputs({
        seats: [
          seat({
            member_canonical: 'auto-user@example.com',
            member_email: 'auto-user@example.com',
            scope: 'CO',
            type: 'auto',
            callings: ['Sunday School Teacher'],
            building_names: ['Maple Building'],
          }),
        ],
        kindooUsers: [
          kuser({
            username: 'auto-user@example.com',
            description: 'Maple Ward (Sunday School Teacher)',
            accessSchedules: [],
            derivedBuildings: null,
          }),
        ],
      }),
    );
    const buildingsRows = result.discrepancies.filter(
      (d) => d.canonical === 'auto-user@example.com' && d.code === 'buildings-mismatch',
    );
    expect(buildingsRows).toEqual([]);
    const allRowsForEmail = result.discrepancies.filter(
      (d) => d.canonical === 'auto-user@example.com',
    );
    expect(allRowsForEmail).toEqual([]);
  });

  it('emits no row for auto seats whose derivedBuildings matches the SBA seat', () => {
    const result = detect(
      baseInputs({
        seats: [
          seat({
            member_canonical: 'auto-match@example.com',
            member_email: 'auto-match@example.com',
            scope: 'CO',
            type: 'auto',
            callings: ['Sunday School Teacher'],
            building_names: ['Maple Building'],
          }),
        ],
        kindooUsers: [
          kuser({
            username: 'auto-match@example.com',
            description: 'Maple Ward (Sunday School Teacher)',
            accessSchedules: [],
            derivedBuildings: ['Maple Building'],
          }),
        ],
      }),
    );
    expect(result.discrepancies).toEqual([]);
  });

  it('emits buildings-mismatch for auto seats whose derivedBuildings differs from the SBA seat', () => {
    const result = detect(
      baseInputs({
        seats: [
          seat({
            member_canonical: 'auto-diff@example.com',
            member_email: 'auto-diff@example.com',
            scope: 'CO',
            type: 'auto',
            callings: ['Sunday School Teacher'],
            building_names: ['Maple Building'],
          }),
        ],
        kindooUsers: [
          kuser({
            username: 'auto-diff@example.com',
            description: 'Maple Ward (Sunday School Teacher)',
            accessSchedules: [],
            derivedBuildings: ['Maple Building', 'Pine Creek Building'],
          }),
        ],
      }),
    );
    expect(result.discrepancies).toHaveLength(1);
    expect(result.discrepancies[0]?.code).toBe('buildings-mismatch');
    expect(result.discrepancies[0]?.reason).toContain('Maple Building, Pine Creek Building');
    // KindooBlock surfaces derivedBuildings so the fix dispatcher and
    // the row UI can use it.
    expect(result.discrepancies[0]?.kindoo?.derivedBuildings).toEqual([
      'Maple Building',
      'Pine Creek Building',
    ]);
  });

  it('emits buildings-mismatch for auto seats whose derivedBuildings is empty against a non-empty SBA seat', () => {
    const result = detect(
      baseInputs({
        seats: [
          seat({
            member_canonical: 'auto-empty@example.com',
            member_email: 'auto-empty@example.com',
            scope: 'CO',
            type: 'auto',
            callings: ['Sunday School Teacher'],
            building_names: ['Maple Building'],
          }),
        ],
        kindooUsers: [
          kuser({
            username: 'auto-empty@example.com',
            description: 'Maple Ward (Sunday School Teacher)',
            accessSchedules: [],
            derivedBuildings: [],
          }),
        ],
      }),
    );
    expect(result.discrepancies).toHaveLength(1);
    expect(result.discrepancies[0]?.code).toBe('buildings-mismatch');
  });

  it('emits no row for a manual seat whose derivedBuildings matches the SBA seat even with empty AccessSchedules', () => {
    // Regression: a member with church-auto DIRECT door grants for
    // Lexington, then a manual SBA seat (building_names=[Lexington]).
    // SBA skipped writing an AccessSchedule rule because Lexington was
    // already effective via the direct grants, so AccessSchedules is
    // empty — but `derivedBuildings` (the door-grant chain) sees it.
    // Comparing against `derivedBuildings` (not AccessSchedules) yields
    // no mismatch, so "Update SBA" never wipes the seat.
    const result = detect(
      baseInputs({
        seats: [
          seat({
            member_canonical: 'manual-direct@example.com',
            member_email: 'manual-direct@example.com',
            scope: 'CO',
            type: 'manual',
            callings: [],
            // Manual seat, so callings-mismatch never fires (auto-only) —
            // this test is strictly about buildings not drifting.
            reason: 'Building Greeter',
            building_names: ['Maple Building'],
          }),
        ],
        kindooUsers: [
          kuser({
            username: 'manual-direct@example.com',
            description: 'Maple Ward (Building Greeter)',
            accessSchedules: [],
            derivedBuildings: ['Maple Building'],
            // No direct grant → not church-backed → stays manual (no
            // type-mismatch). Buildings match → no row at all.
            directGrantBuildings: [],
          }),
        ],
      }),
    );
    expect(result.discrepancies).toEqual([]);
  });

  it('emits buildings-mismatch for a manual seat when derivedBuildings differs from the SBA seat', () => {
    const result = detect(
      baseInputs({
        seats: [
          seat({
            member_canonical: 'manual-diff@example.com',
            member_email: 'manual-diff@example.com',
            scope: 'CO',
            type: 'manual',
            callings: [],
            reason: 'Requested by bishop',
            building_names: [],
          }),
        ],
        kindooUsers: [
          kuser({
            username: 'manual-diff@example.com',
            description: 'Maple Ward (Building Greeter)',
            accessSchedules: [],
            derivedBuildings: ['Maple Building'],
          }),
        ],
      }),
    );
    expect(result.discrepancies).toHaveLength(1);
    expect(result.discrepancies[0]?.code).toBe('buildings-mismatch');
    expect(result.discrepancies[0]?.kindoo?.derivedBuildings).toEqual(['Maple Building']);
  });

  it('falls back to AccessSchedules for a manual seat when derivedBuildings is null', () => {
    // When door-grant derivation failed (`derivedBuildings === null`),
    // manual/temp seats compare against the AccessSchedules-derived set.
    const result = detect(
      baseInputs({
        seats: [
          seat({
            member_canonical: 'manual-fallback@example.com',
            member_email: 'manual-fallback@example.com',
            scope: 'CO',
            type: 'manual',
            callings: [],
            reason: 'Requested by bishop',
            building_names: ['Maple Building', 'Pine Creek Building'],
          }),
        ],
        kindooUsers: [
          kuser({
            username: 'manual-fallback@example.com',
            description: 'Maple Ward (Building Greeter)',
            accessSchedules: [{ ruleId: 6248 }],
            derivedBuildings: null,
          }),
        ],
      }),
    );
    expect(result.discrepancies).toHaveLength(1);
    expect(result.discrepancies[0]?.code).toBe('buildings-mismatch');
    // Reason reflects the AccessSchedules-derived Maple set, not derived.
    expect(result.discrepancies[0]?.reason).toContain('Kindoo=[Maple Building]');
  });

  it('emits buildings-mismatch for temp seats when rule set differs', () => {
    const result = detect(
      baseInputs({
        seats: [
          seat({
            type: 'temp',
            callings: [],
            reason: 'Visiting speaker',
            building_names: ['Maple Building', 'Pine Creek Building'],
          }),
        ],
        kindooUsers: [
          kuser({
            isTempUser: true,
            description: 'Maple Ward (Visiting speaker)',
            accessSchedules: [{ ruleId: 6248 }],
          }),
        ],
      }),
    );
    expect(result.discrepancies).toHaveLength(1);
    expect(result.discrepancies[0]?.code).toBe('buildings-mismatch');
  });

  it("emits callings-mismatch carrying Kindoo's FULL set when the seat differs (superset case)", () => {
    const result = detect(
      baseInputs({
        seats: [seat({ scope: 'CO', type: 'auto', callings: ['Sunday School Teacher'] })],
        kindooUsers: [
          kuser({
            description: 'Maple Ward (Sunday School Teacher, Building Janitor)',
            // Church-backed auto so no type-mismatch preempts the row.
            derivedBuildings: ['Maple Building'],
            directGrantBuildings: ['Maple Building'],
          }),
        ],
      }),
    );
    expect(result.discrepancies).toHaveLength(1);
    const row = result.discrepancies[0]!;
    expect(row.code).toBe('callings-mismatch');
    expect(row.severity).toBe('drift');
    // The FULL Kindoo target set (REPLACE), not a delta — the seat's
    // existing calling is part of the target too.
    expect(row.kindoo?.kindooCallings).toEqual(['Sunday School Teacher', 'Building Janitor']);
    expect(row.reason).toContain('[Sunday School Teacher, Building Janitor]');
    expect(row.reason).toContain('update SBA to match Kindoo');
  });

  it("emits callings-mismatch on a RENAME, carrying ONLY Kindoo's renamed calling (REPLACE, not append)", () => {
    // The motivating bug: Kindoo renamed `Bishop` → `Bishopric Clerk`. The
    // seat must MIRROR Kindoo (replace), not accumulate both.
    const result = detect(
      baseInputs({
        seats: [
          seat({
            scope: 'CO',
            type: 'auto',
            callings: ['Bishop'],
            building_names: ['Maple Building'],
          }),
        ],
        kindooUsers: [
          kuser({
            description: 'Maple Ward (Bishopric Clerk)',
            derivedBuildings: ['Maple Building'],
            directGrantBuildings: ['Maple Building'],
          }),
        ],
      }),
    );
    expect(result.discrepancies).toHaveLength(1);
    const row = result.discrepancies[0]!;
    expect(row.code).toBe('callings-mismatch');
    // FULL target set is just Kindoo's renamed calling — the old `Bishop`
    // is NOT carried forward.
    expect(row.kindoo?.kindooCallings).toEqual(['Bishopric Clerk']);
    expect(row.reason).toContain('[Bishopric Clerk]');
    expect(row.reason).toContain('[Bishop]');
  });

  it('does NOT emit callings-mismatch when the seat already matches every Kindoo calling', () => {
    const result = detect(
      baseInputs({
        seats: [
          seat({
            scope: 'CO',
            type: 'auto',
            callings: ['Sunday School Teacher', 'Building Janitor'],
            building_names: ['Maple Building'],
          }),
        ],
        kindooUsers: [
          kuser({
            description: 'Maple Ward (Sunday School Teacher, Building Janitor)',
            derivedBuildings: ['Maple Building'],
            directGrantBuildings: ['Maple Building'],
          }),
        ],
      }),
    );
    expect(result.discrepancies.filter((d) => d.code === 'callings-mismatch')).toEqual([]);
  });

  it('does NOT emit callings-mismatch on case / whitespace-only differences', () => {
    const result = detect(
      baseInputs({
        seats: [
          seat({
            scope: 'CO',
            type: 'auto',
            // Different casing + padding than the Kindoo parens.
            callings: ['sunday school teacher', '  Building Janitor  '],
            building_names: ['Maple Building'],
          }),
        ],
        kindooUsers: [
          kuser({
            description: 'Maple Ward (Sunday School Teacher,  Building Janitor )',
            derivedBuildings: ['Maple Building'],
            directGrantBuildings: ['Maple Building'],
          }),
        ],
      }),
    );
    expect(result.discrepancies.filter((d) => d.code === 'callings-mismatch')).toEqual([]);
  });

  it('NEVER emits callings-mismatch for a manual seat, regardless of reason content', () => {
    // Operator decision 2026-05-30: callings-mismatch is auto-only.
    // Manual seats record their calling in the free-text `reason`, which
    // is frequently operator prose (not a calling name); surfacing the
    // diff on them would flood the review list. So a manual seat — even
    // one whose `reason` is unrelated to the Kindoo parens — never fires.
    const result = detect(
      baseInputs({
        seats: [
          seat({
            scope: 'CO',
            type: 'manual',
            callings: [],
            reason: 'After-hours building access',
            building_names: ['Maple Building'],
          }),
        ],
        kindooUsers: [
          kuser({
            description: 'Maple Ward (Building Greeter)',
            derivedBuildings: ['Maple Building'],
            directGrantBuildings: [],
          }),
        ],
      }),
    );
    expect(result.discrepancies).toEqual([]);
  });

  it('NEVER emits callings-mismatch for a temp seat, regardless of reason content', () => {
    const result = detect(
      baseInputs({
        seats: [
          seat({
            scope: 'CO',
            type: 'temp',
            callings: [],
            reason: 'Visiting speaker',
            building_names: ['Maple Building'],
          }),
        ],
        kindooUsers: [
          kuser({
            isTempUser: true,
            description: 'Maple Ward (Building Greeter)',
            derivedBuildings: ['Maple Building'],
            directGrantBuildings: ['Maple Building'],
          }),
        ],
      }),
    );
    expect(result.discrepancies).toEqual([]);
  });

  it('does NOT compare an auto seat against its reason — only against callings[]', () => {
    // An auto seat's `callings[]` is the source; even if some stray
    // reason text existed, the auto path ignores it. Here callings
    // already covers the Kindoo parens → no row.
    const result = detect(
      baseInputs({
        seats: [
          seat({
            scope: 'CO',
            type: 'auto',
            callings: ['Sunday School Teacher'],
            building_names: ['Maple Building'],
          }),
        ],
        kindooUsers: [
          kuser({
            description: 'Maple Ward (Sunday School Teacher)',
            derivedBuildings: ['Maple Building'],
            directGrantBuildings: ['Maple Building'],
          }),
        ],
      }),
    );
    expect(result.discrepancies).toEqual([]);
  });

  it('callings-mismatch is the only row emitted when scope and type otherwise agree', () => {
    // Mixed segment now classifies as auto (not manual), so the
    // downstream type-mismatch / buildings-mismatch checks must not
    // also fire on the same row.
    const result = detect(
      baseInputs({
        seats: [
          seat({
            scope: 'CO',
            type: 'auto',
            callings: ['Sunday School Teacher'],
            building_names: ['Maple Building'],
          }),
        ],
        kindooUsers: [
          kuser({
            description: 'Maple Ward (Sunday School Teacher, Accompanist)',
            accessSchedules: [{ ruleId: 6248 }],
          }),
        ],
      }),
    );
    expect(result.discrepancies).toHaveLength(1);
    expect(result.discrepancies[0]?.code).toBe('callings-mismatch');
  });

  it('does NOT emit callings-mismatch when Kindoo names a scope but NO calling (empty target)', () => {
    // `Maple Ward` with no parens → primary segment carries an empty
    // calling string. The callable rejects empty `callings`, so the
    // detector must leave it to the other codes / no row.
    const result = detect(
      baseInputs({
        seats: [
          seat({
            scope: 'CO',
            type: 'auto',
            callings: ['Sunday School Teacher'],
            building_names: ['Maple Building'],
          }),
        ],
        kindooUsers: [
          kuser({
            description: 'Maple Ward',
            derivedBuildings: ['Maple Building'],
            directGrantBuildings: ['Maple Building'],
          }),
        ],
      }),
    );
    expect(result.discrepancies.filter((d) => d.code === 'callings-mismatch')).toEqual([]);
  });

  it('reports counts independent of discrepancies emitted', () => {
    const result = detect(
      baseInputs({
        seats: [
          seat({ member_canonical: 'a@example.com' }),
          seat({ member_canonical: 'b@example.com' }),
        ],
        kindooUsers: [kuser({ username: 'c@example.com' })],
      }),
    );
    expect(result.seatCount).toBe(2);
    expect(result.kindooCount).toBe(1);
    // Three discrepancies: 2 sba-only + 1 kindoo-only.
    expect(result.discrepancies).toHaveLength(3);
  });

  it('sorts drift before review and ties alphabetically by email', () => {
    // `z@example.com` has a blank Kindoo description → kindoo-no-description
    // (the one review-severity code). `b-orphan@example.com` is an
    // sba-only drift row. Drift must sort ahead of review regardless of
    // email ordering (b < z, but the review row would lose anyway).
    const inputs = baseInputs({
      seats: [
        seat({ member_canonical: 'z@example.com', member_email: 'z@example.com' }),
        seat({ member_canonical: 'a@example.com', member_email: 'a@example.com' }),
        seat({ member_canonical: 'b-orphan@example.com', member_email: 'b-orphan@example.com' }),
      ],
      kindooUsers: [
        // blank description → kindoo-no-description (review)
        kuser({ username: 'z@example.com', description: '' }),
        // matches SBA on a@example.com → no row
        kuser({ username: 'a@example.com' }),
      ],
    });
    const sorted = detect(inputs);
    expect(sorted.discrepancies[0]?.code).toBe('sba-only');
    expect(sorted.discrepancies[0]?.displayEmail).toBe('b-orphan@example.com');
    expect(sorted.discrepancies[1]?.code).toBe('kindoo-no-description');
    expect(sorted.discrepancies[1]?.displayEmail).toBe('z@example.com');
  });

  it('canonicalizes Kindoo usernames before joining with seat emails', () => {
    // Seat uses Gmail-canonical (no dots, no +suffix).
    const result = detect(
      baseInputs({
        seats: [
          seat({ member_canonical: 'tadesmith@gmail.com', member_email: 'tadesmith@gmail.com' }),
        ],
        kindooUsers: [kuser({ username: 'tad.e.smith+test@gmail.com' })],
      }),
    );
    expect(result.discrepancies).toEqual([]);
  });

  it('flags an unknown Kindoo rule ID via "(unknown rule X)" placeholder', () => {
    const result = detect(
      baseInputs({
        seats: [
          seat({
            type: 'manual',
            callings: [],
            reason: 'Requested by bishop',
            building_names: ['Maple Building'],
          }),
        ],
        kindooUsers: [
          kuser({
            description: 'Maple Ward (Building Greeter)',
            accessSchedules: [{ ruleId: 99999 }],
          }),
        ],
      }),
    );
    expect(result.discrepancies).toHaveLength(1);
    expect(result.discrepancies[0]?.code).toBe('buildings-mismatch');
    expect(result.discrepancies[0]?.reason).toContain('(unknown rule 99999)');
  });

  it('detects equal building sets ordered differently (manual seat)', () => {
    const result = detect(
      baseInputs({
        seats: [
          seat({
            type: 'manual',
            callings: [],
            // Reason matches the Kindoo parens so the callings diff
            // stays quiet — this test is strictly about building-set
            // order-insensitivity.
            reason: 'Building Greeter',
            building_names: ['Maple Building', 'Pine Creek Building'],
          }),
        ],
        kindooUsers: [
          kuser({
            description: 'Maple Ward (Building Greeter)',
            accessSchedules: [{ ruleId: 6249 }, { ruleId: 6248 }],
          }),
        ],
      }),
    );
    expect(result.discrepancies).toEqual([]);
  });

  it('emits no scope-mismatch when the stake segment is non-app-access but the ward segment app-accesses (two-segment ward-priority shape)', () => {
    // Restored app-access primary preference (hard-coded lists, not
    // templates): SBA seat is scope=CO/auto; Kindoo description carries a
    // non-app-access stake calling (Technology Specialist) alongside a
    // ward app-access calling (Bishop). The app-access ward segment wins
    // primary, so its CO scope matches the seat and no scope-mismatch
    // emits — no spurious drift row.
    const result = detect(
      baseInputs({
        seats: [
          seat({
            member_canonical: 'user2@example.com',
            member_email: 'user2@example.com',
            scope: 'CO',
            type: 'auto',
            callings: ['Bishop'],
          }),
        ],
        kindooUsers: [
          kuser({
            username: 'user2@example.com',
            description:
              'Colorado Springs North Stake (Technology Specialist)  |  Maple Ward (Bishop)',
            accessSchedules: [{ ruleId: 6248 }],
          }),
        ],
      }),
    );
    const rowsForEmail = result.discrepancies.filter((d) => d.canonical === 'user2@example.com');
    expect(rowsForEmail).toEqual([]);
  });

  it('counts kindoo-only users with unresolvable descriptions as kindoo-only (not unparseable)', () => {
    // kindoo-only takes priority over unparseable for users with no seat.
    const result = detect(
      baseInputs({
        kindooUsers: [kuser({ description: 'Kindoo Manager - Stake Clerk' })],
      }),
    );
    expect(result.discrepancies).toHaveLength(1);
    expect(result.discrepancies[0]?.code).toBe('kindoo-only');
  });

  // --------------------------------------------------------------------
  // Phase 4 — active-site filter. The detector filters both sides of
  // the diff to seats / users belonging to the active Kindoo site. See
  // `content/kindoo/sync/activeSite.ts` + `docs/spec.md` §15.
  // --------------------------------------------------------------------

  // Mixed home + foreign fixture. Two wards: Maple (home) and Pine
  // (foreign-site 'east-stake'). A ward's site derives from its building,
  // so Pine Ward sits on 'Pine Building', whose `kindoo_site_id` is
  // 'east-stake'. Plus stake-scope seats and Kindoo users on each side.
  const WARDS_MIXED: Ward[] = [
    ward('CO', 'Maple Ward', 'Maple Building'),
    ward('FT', 'Pine Ward', 'Pine Building'),
  ];
  const BUILDINGS_MIXED: Building[] = [
    ...BUILDINGS,
    building('pine', 'Pine Building', 6250, 'east-stake'),
  ];

  function mixedInputs(overrides: {
    seats?: Seat[];
    kindooUsers?: KindooEnvironmentUser[];
    activeSite?: import('./activeSite').ActiveSite;
  }) {
    return {
      stake: STAKE,
      wards: WARDS_MIXED,
      buildings: BUILDINGS_MIXED,
      seats: overrides.seats ?? [],
      kindooUsers: overrides.kindooUsers ?? [],
      ...(overrides.activeSite !== undefined ? { activeSite: overrides.activeSite } : {}),
    };
  }

  it('home-active preserves existing behavior across the existing fixture (no kindoo_site_id set)', () => {
    // Wards without `kindoo_site_id` are treated as home — passing
    // `activeSite: home` against the original fixture should not drop
    // any rows.
    const result = detect({
      ...baseInputs({
        seats: [seat({})],
        kindooUsers: [kuser({})],
      }),
      activeSite: { kind: 'home' },
    });
    expect(result.discrepancies).toEqual([]);
    expect(result.seatCount).toBe(1);
    expect(result.kindooCount).toBe(1);
  });

  it('home-active includes home-ward seats + stake-scope seats; excludes foreign-ward seats', () => {
    const homeSeat = seat({
      member_canonical: 'home@example.com',
      member_email: 'home@example.com',
      scope: 'CO',
    });
    const stakeSeat = seat({
      member_canonical: 'stake@example.com',
      member_email: 'stake@example.com',
      scope: 'stake',
    });
    const foreignSeat = seat({
      member_canonical: 'foreign@example.com',
      member_email: 'foreign@example.com',
      scope: 'FT',
    });
    const result = detect(
      mixedInputs({
        seats: [homeSeat, stakeSeat, foreignSeat],
        kindooUsers: [],
        activeSite: { kind: 'home' },
      }),
    );
    // foreign-ward seat dropped; home + stake remain as sba-only drift.
    const canonicals = result.discrepancies.map((d) => d.canonical).sort();
    expect(canonicals).toEqual(['home@example.com', 'stake@example.com']);
    expect(result.seatCount).toBe(2);
  });

  it('foreign-active includes only that foreign-ward seats; excludes home + other-foreign + stake', () => {
    const homeSeat = seat({
      member_canonical: 'home@example.com',
      member_email: 'home@example.com',
      scope: 'CO',
    });
    const stakeSeat = seat({
      member_canonical: 'stake@example.com',
      member_email: 'stake@example.com',
      scope: 'stake',
    });
    const foreignSeat = seat({
      member_canonical: 'foreign@example.com',
      member_email: 'foreign@example.com',
      scope: 'FT',
    });
    const result = detect(
      mixedInputs({
        seats: [homeSeat, stakeSeat, foreignSeat],
        kindooUsers: [],
        activeSite: { kind: 'foreign', siteId: 'east-stake' },
      }),
    );
    // Stake-scope dropped (home-only per Phase 1 policy). Home dropped.
    expect(result.discrepancies.map((d) => d.canonical)).toEqual(['foreign@example.com']);
    expect(result.seatCount).toBe(1);
  });

  it('foreign-active drops Kindoo users whose description resolves to home wards', () => {
    // A home-ward Kindoo user appears in the bulk listing even when the
    // operator is logged into a foreign site (Kindoo doesn't filter the
    // listing for us — it's all users in that environment). When parsed
    // to a home ward, the user belongs to another manager's queue and
    // should NOT surface as kindoo-only drift.
    const result = detect(
      mixedInputs({
        seats: [],
        kindooUsers: [
          kuser({
            username: 'home-user@example.com',
            description: 'Maple Ward (Sunday School Teacher)',
          }),
          kuser({
            username: 'foreign-user@example.com',
            description: 'Pine Ward (Sunday School Teacher)',
          }),
        ],
        activeSite: { kind: 'foreign', siteId: 'east-stake' },
      }),
    );
    // Only the foreign-ward Kindoo user shows up as kindoo-only drift.
    expect(result.discrepancies.map((d) => d.canonical)).toEqual(['foreign-user@example.com']);
    expect(result.kindooCount).toBe(1);
  });

  it('unknown-active returns an empty diff and zero counts', () => {
    const result = detect(
      mixedInputs({
        seats: [
          seat({
            member_canonical: 'home@example.com',
            member_email: 'home@example.com',
            scope: 'CO',
          }),
        ],
        kindooUsers: [
          kuser({
            username: 'k@example.com',
            description: 'Maple Ward (Sunday School Teacher)',
          }),
        ],
        activeSite: { kind: 'unknown' },
      }),
    );
    expect(result.discrepancies).toEqual([]);
    expect(result.seatCount).toBe(0);
    expect(result.kindooCount).toBe(0);
  });

  // ----- T-42 multi-site fan-out -----
  //
  // A Kindoo user whose Description spans home + foreign sites must
  // surface on both site views (acceptance #1 + #2). The seat doc's
  // primary lives on the home site, with a `duplicate_grants[]`
  // entry on the foreign site — each side projects to its own
  // expected (scope, type, callings, buildings).

  it('T-42: ward+foreign-ward Description appears on both home and foreign sync views with no spurious drift', () => {
    // Multi-site user: Bishop in Maple (home) + Sunday School Teacher
    // in Pine (foreign). Seat carries the home primary + a foreign
    // duplicate. Description carries both segments.
    const multiSeat = seat({
      member_canonical: 'multi@example.com',
      member_email: 'multi@example.com',
      member_name: 'Multi Site',
      scope: 'CO',
      type: 'auto',
      callings: ['Sunday School Teacher'],
      building_names: ['Maple Building'],
      kindoo_site_id: null,
      duplicate_grants: [
        {
          scope: 'FT',
          type: 'auto',
          callings: ['Sunday School Teacher'],
          building_names: ['Pine Building'],
          kindoo_site_id: 'east-stake',
          detected_at: ts(),
        },
      ],
    });
    const multiKuser = kuser({
      euid: 'e-multi',
      userId: 'u-multi',
      username: 'multi@example.com',
      description: 'Maple Ward (Sunday School Teacher) | Pine Ward (Sunday School Teacher)',
      accessSchedules: [{ ruleId: 6248 }, { ruleId: 6249 }],
    });

    // Home view: expects Maple (rule 6248). The home segment matches
    // the seat's home primary; no drift.
    const homeResult = detect(
      mixedInputs({
        seats: [multiSeat],
        kindooUsers: [multiKuser],
        activeSite: { kind: 'home' },
      }),
    );
    expect(homeResult.discrepancies).toEqual([]);
    expect(homeResult.seatCount).toBe(1);
    expect(homeResult.kindooCount).toBe(1);

    // Foreign view: expects Pine (rule 6249). The foreign segment
    // matches the seat's foreign duplicate; no drift.
    const foreignResult = detect(
      mixedInputs({
        seats: [multiSeat],
        kindooUsers: [multiKuser],
        activeSite: { kind: 'foreign', siteId: 'east-stake' },
      }),
    );
    expect(foreignResult.discrepancies).toEqual([]);
    expect(foreignResult.seatCount).toBe(1);
    expect(foreignResult.kindooCount).toBe(1);
  });

  it('T-42: stake+foreign-ward Description appears on both home (stake) and foreign-ward views', () => {
    // Stake Clerk + Sunday School Teacher in Pine (foreign). Seat:
    // stake primary + foreign duplicate. Description carries both. Per
    // operator-locked decision 2, stake-scope is home-only — so the
    // home view sees the stake segment, the foreign view sees the
    // foreign segment, and neither manufactures drift.
    const multiSeat = seat({
      member_canonical: 'sc@example.com',
      member_email: 'sc@example.com',
      member_name: 'Stake Clerk',
      scope: 'stake',
      type: 'auto',
      callings: ['Stake Clerk'],
      building_names: ['Maple Building'],
      kindoo_site_id: null,
      duplicate_grants: [
        {
          scope: 'FT',
          type: 'auto',
          callings: ['Sunday School Teacher'],
          building_names: ['Pine Building'],
          kindoo_site_id: 'east-stake',
          detected_at: ts(),
        },
      ],
    });
    const multiKuser = kuser({
      euid: 'e-sc',
      userId: 'u-sc',
      username: 'sc@example.com',
      description: 'Colorado Springs North Stake (Stake Clerk) | Pine Ward (Sunday School Teacher)',
      accessSchedules: [{ ruleId: 6248 }, { ruleId: 6249 }],
    });

    // Home view: picks the stake segment (resolves to scope='stake')
    // and matches the seat's stake-scope primary. No drift.
    const homeResult = detect(
      mixedInputs({
        seats: [multiSeat],
        kindooUsers: [multiKuser],
        activeSite: { kind: 'home' },
      }),
    );
    expect(homeResult.discrepancies).toEqual([]);
    expect(homeResult.seatCount).toBe(1);
    expect(homeResult.kindooCount).toBe(1);

    // Foreign view: picks the Pine segment and matches the seat's
    // foreign duplicate. No drift.
    const foreignResult = detect(
      mixedInputs({
        seats: [multiSeat],
        kindooUsers: [multiKuser],
        activeSite: { kind: 'foreign', siteId: 'east-stake' },
      }),
    );
    expect(foreignResult.discrepancies).toEqual([]);
    expect(foreignResult.seatCount).toBe(1);
    expect(foreignResult.kindooCount).toBe(1);
  });

  it('T-42: foreign-site duplicate makes a home-primary seat visible on the foreign view', () => {
    // Seat's primary is on the home site but it carries a foreign-site
    // duplicate (the new T-42 case). The foreign view should now see
    // this seat — pre-T-42 the active-site filter looked at
    // `seat.scope` alone and dropped it.
    const multiSeat = seat({
      member_canonical: 'multi@example.com',
      member_email: 'multi@example.com',
      scope: 'CO',
      kindoo_site_id: null,
      callings: ['Sunday School Teacher'],
      building_names: ['Maple Building'],
      duplicate_grants: [
        {
          scope: 'FT',
          type: 'auto',
          callings: ['Sunday School Teacher'],
          building_names: ['Pine Building'],
          kindoo_site_id: 'east-stake',
          detected_at: ts(),
        },
      ],
    });
    // Foreign-view: no Kindoo user yet → sba-only on the foreign side.
    const result = detect(
      mixedInputs({
        seats: [multiSeat],
        kindooUsers: [],
        activeSite: { kind: 'foreign', siteId: 'east-stake' },
      }),
    );
    expect(result.discrepancies.map((d) => d.code)).toEqual(['sba-only']);
    expect(result.discrepancies[0]!.canonical).toBe('multi@example.com');
    // The projected SBA block reflects the foreign side, not the
    // home-side primary.
    expect(result.discrepancies[0]!.sba?.scope).toBe('FT');
    expect(result.discrepancies[0]!.sba?.buildingNames).toEqual(['Pine Building']);
  });

  it('T-42: two foreign wards on the same foreign site → projection unions both building_names', () => {
    // Spec §15 line 373: "Two foreign wards on the same foreign site
    // produce two `duplicate_grants[]` entries… the sync detector
    // unions their `building_names` per-site when computing expected
    // buildings." Fixture: a seat with the home primary on Maple
    // plus TWO foreign-site duplicates (Pine + Mountain View),
    // both bound to 'east-stake'. The foreign-view projection must
    // include BOTH foreign buildings, not just one.
    const wardsTwoForeign: Ward[] = [
      ward('CO', 'Maple Ward', 'Maple Building'),
      ward('FT', 'Pine Ward', 'Pine Building'),
      ward('MV', 'Mountain View Ward', 'Mountain View Building'),
    ];
    const buildingsTwoForeign: Building[] = [
      ...BUILDINGS,
      building('pine', 'Pine Building', 6250, 'east-stake'),
      building('mtnview', 'Mountain View Building', 6251, 'east-stake'),
    ];
    const multiSeat = seat({
      member_canonical: 'multi@example.com',
      member_email: 'multi@example.com',
      scope: 'CO',
      kindoo_site_id: null,
      callings: ['Sunday School Teacher'],
      building_names: ['Maple Building'],
      duplicate_grants: [
        {
          scope: 'FT',
          type: 'auto',
          callings: ['Sunday School Teacher'],
          building_names: ['Pine Building'],
          kindoo_site_id: 'east-stake',
          detected_at: ts(),
        },
        {
          scope: 'MV',
          type: 'auto',
          callings: ['Sunday School Teacher'],
          building_names: ['Mountain View Building'],
          kindoo_site_id: 'east-stake',
          detected_at: ts(),
        },
      ],
    });
    const result = detect({
      stake: STAKE,
      wards: wardsTwoForeign,
      buildings: buildingsTwoForeign,
      seats: [multiSeat],
      kindooUsers: [],
      activeSite: { kind: 'foreign', siteId: 'east-stake' },
    });
    // Foreign view: sba-only with the union of BOTH foreign duplicates'
    // buildings (Pine + Mountain View).
    expect(result.discrepancies).toHaveLength(1);
    expect(result.discrepancies[0]!.code).toBe('sba-only');
    expect(result.discrepancies[0]!.sba?.buildingNames.sort()).toEqual(
      ['Pine Building', 'Mountain View Building'].sort(),
    );
  });
});
