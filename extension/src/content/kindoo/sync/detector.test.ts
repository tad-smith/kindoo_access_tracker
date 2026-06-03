// Detector tests. Covers each DiscrepancyCode + the all-good no-emit
// path + the severity sort + the seat / kindoo counters.

import { describe, expect, it } from 'vitest';
import type { Building, CallingTemplate, Seat, Stake, Ward } from '@kindoo/shared';
import type { KindooEnvironmentUser } from '../endpoints';
import { detect, grantsBackAuto, isChurchBacked, parseKindooCallings } from './detector';

describe('isChurchBacked', () => {
  it('true when every seat building is direct-granted', () => {
    expect(isChurchBacked(['A', 'B'], ['A', 'B', 'C'])).toBe(true);
  });
  it('false when one seat building is not direct-granted (conservative)', () => {
    expect(isChurchBacked(['A', 'B'], ['A'])).toBe(false);
  });
  it('false when directGrantBuildings is null (cannot determine)', () => {
    expect(isChurchBacked(['A'], null)).toBe(false);
  });
  it('true (vacuously) for a seat with no buildings when the set is known', () => {
    expect(isChurchBacked([], [])).toBe(true);
    expect(isChurchBacked([], ['A'])).toBe(true);
  });
});

describe('grantsBackAuto', () => {
  it('true when the seat has buildings and all are direct-granted', () => {
    expect(grantsBackAuto(['A'], ['A', 'B'])).toBe(true);
  });
  it('false for a zero-building seat (NOT vacuously auto — born manual)', () => {
    expect(grantsBackAuto([], [])).toBe(false);
    expect(grantsBackAuto([], ['A'])).toBe(false);
  });
  it('false when a building is not direct-granted', () => {
    expect(grantsBackAuto(['A', 'B'], ['A'])).toBe(false);
  });
  it('false when directGrantBuildings is null', () => {
    expect(grantsBackAuto(['A'], null)).toBe(false);
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

function ts(): CallingTemplate['created_at'] {
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
    expiry_hour: 3,
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

function building(id: string, name: string, ruleId: number | null): Building {
  return {
    building_id: id,
    building_name: name,
    address: '123 Main',
    ...(ruleId !== null ? { kindoo_rule: { rule_id: ruleId, rule_name: `${name} Doors` } } : {}),
    created_at: ts(),
    last_modified_at: ts(),
    lastActor: { email: 'sys@example.com', canonical: 'sys@example.com' },
  };
}

function template(name: string, auto = true): CallingTemplate {
  return {
    calling_name: name,
    give_app_access: true,
    auto_kindoo_access: auto,
    sheet_order: 1,
    created_at: ts(),
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
    ...overrides,
  };
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
const WARD_TEMPLATES = [template('Sunday School Teacher'), template('Elders Quorum President')];
const STAKE_TEMPLATES = [template('Stake Clerk')];

function baseInputs(overrides: { seats?: Seat[]; kindooUsers?: KindooEnvironmentUser[] }) {
  return {
    stake: STAKE,
    wards: WARDS,
    buildings: BUILDINGS,
    seats: overrides.seats ?? [],
    wardCallingTemplates: WARD_TEMPLATES,
    stakeCallingTemplates: STAKE_TEMPLATES,
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

  it('emits no scope-mismatch when stake segment is non-auto but ward segment auto-matches the seat (two-segment ward-priority shape)', () => {
    // Live false-positive case before the auto-preference primary
    // pick: SBA seat is scope=CO/auto/Sunday School Teacher; Kindoo
    // description carries a non-auto stake calling alongside the auto
    // ward calling. The pre-fix rule picked the stake segment as
    // primary and reported scope-mismatch. Post-fix, the auto ward
    // segment wins and no row emits.
    const result = detect(
      baseInputs({
        seats: [
          seat({
            member_canonical: 'user2@example.com',
            member_email: 'user2@example.com',
            scope: 'CO',
            type: 'auto',
            callings: ['Sunday School Teacher'],
          }),
        ],
        kindooUsers: [
          kuser({
            username: 'user2@example.com',
            description:
              'Colorado Springs North Stake (Technology Specialist)  |  Maple Ward (Sunday School Teacher)',
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
  // (foreign-site 'east-stake'). Plus stake-scope seats and Kindoo users
  // on each side.
  const WARDS_MIXED: Ward[] = [
    ward('CO', 'Maple Ward', 'Maple Building'),
    {
      ...ward('FT', 'Pine Ward', 'Pine Building'),
      kindoo_site_id: 'east-stake',
    },
  ];

  function mixedInputs(overrides: {
    seats?: Seat[];
    kindooUsers?: KindooEnvironmentUser[];
    activeSite?: import('./activeSite').ActiveSite;
  }) {
    return {
      stake: STAKE,
      wards: WARDS_MIXED,
      buildings: BUILDINGS,
      seats: overrides.seats ?? [],
      wardCallingTemplates: WARD_TEMPLATES,
      stakeCallingTemplates: STAKE_TEMPLATES,
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
      {
        ...ward('FT', 'Pine Ward', 'Pine Building'),
        kindoo_site_id: 'east-stake',
      },
      {
        ...ward('MV', 'Mountain View Ward', 'Mountain View Building'),
        kindoo_site_id: 'east-stake',
      },
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
      buildings: BUILDINGS,
      seats: [multiSeat],
      wardCallingTemplates: WARD_TEMPLATES,
      stakeCallingTemplates: STAKE_TEMPLATES,
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
