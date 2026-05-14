// Detector tests. Covers each DiscrepancyCode + the all-good no-emit
// path + the severity sort + the seat / kindoo counters.

import { describe, expect, it } from 'vitest';
import type { Building, CallingTemplate, Seat, Stake, Ward } from '@kindoo/shared';
import type { KindooEnvironmentUser } from '../endpoints';
import { detect } from './detector';

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
    callings_sheet_id: 'sheet-x',
    bootstrap_admin_email: 'admin@csnorth.org',
    setup_complete: true,
    stake_seat_cap: 250,
    expiry_hour: 3,
    import_day: 'SUNDAY',
    import_hour: 6,
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
    building_names: ['Cordera Building'],
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
    description: 'Cordera Ward (Sunday School Teacher)',
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
  ward('CO', 'Cordera Ward', 'Cordera Building'),
  ward('PC', 'Pine Creek Ward', 'Pine Creek Building'),
];
const BUILDINGS = [
  building('cordera', 'Cordera Building', 6248),
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

  it('emits kindoo-unparseable on a Kindoo Manager-style description', () => {
    const result = detect(
      baseInputs({
        seats: [seat({})],
        kindooUsers: [kuser({ description: 'Kindoo Manager - Stake Clerk' })],
      }),
    );
    expect(result.discrepancies).toHaveLength(1);
    expect(result.discrepancies[0]?.code).toBe('kindoo-unparseable');
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

  it('emits type-mismatch when intended type differs from seat.type', () => {
    const result = detect(
      baseInputs({
        seats: [seat({ scope: 'CO', type: 'manual', callings: [], reason: 'Requested by bishop' })],
        kindooUsers: [kuser({ description: 'Cordera Ward (Sunday School Teacher)' })],
      }),
    );
    expect(result.discrepancies).toHaveLength(1);
    expect(result.discrepancies[0]?.code).toBe('type-mismatch');
  });

  it('emits buildings-mismatch when manual seat rule set vs SBA building set differs', () => {
    const result = detect(
      baseInputs({
        seats: [
          seat({
            type: 'manual',
            callings: [],
            reason: 'Requested by bishop',
            building_names: ['Cordera Building', 'Pine Creek Building'],
          }),
        ],
        kindooUsers: [
          kuser({
            description: 'Cordera Ward (Building Greeter)',
            accessSchedules: [{ ruleId: 6248 }],
          }),
        ],
      }),
    );
    expect(result.discrepancies).toHaveLength(1);
    expect(result.discrepancies[0]?.code).toBe('buildings-mismatch');
  });

  it('skips buildings comparison for auto seats (direct door grants not in AccessSchedules)', () => {
    // Auto-imported users receive door access via direct door grants keyed by
    // VidName, which the bulk listing's AccessSchedules array does not
    // expose. Even with an empty (or stale) AccessSchedules list, the auto
    // seat should not emit a buildings-mismatch row.
    const result = detect(
      baseInputs({
        seats: [
          seat({
            member_canonical: 'auto-user@example.com',
            member_email: 'auto-user@example.com',
            scope: 'CO',
            type: 'auto',
            callings: ['Sunday School Teacher'],
            building_names: ['Cordera Building'],
          }),
        ],
        kindooUsers: [
          kuser({
            username: 'auto-user@example.com',
            description: 'Cordera Ward (Sunday School Teacher)',
            accessSchedules: [],
          }),
        ],
      }),
    );
    const buildingsRows = result.discrepancies.filter(
      (d) => d.canonical === 'auto-user@example.com' && d.code === 'buildings-mismatch',
    );
    expect(buildingsRows).toEqual([]);
    // The auto path should emit nothing at all for this email — scope and
    // type both match, and buildings is skipped.
    const allRowsForEmail = result.discrepancies.filter(
      (d) => d.canonical === 'auto-user@example.com',
    );
    expect(allRowsForEmail).toEqual([]);
  });

  it('emits buildings-mismatch for temp seats when rule set differs', () => {
    const result = detect(
      baseInputs({
        seats: [
          seat({
            type: 'temp',
            callings: [],
            reason: 'Visiting speaker',
            building_names: ['Cordera Building', 'Pine Creek Building'],
          }),
        ],
        kindooUsers: [
          kuser({
            isTempUser: true,
            description: 'Cordera Ward (Visiting speaker)',
            accessSchedules: [{ ruleId: 6248 }],
          }),
        ],
      }),
    );
    expect(result.discrepancies).toHaveLength(1);
    expect(result.discrepancies[0]?.code).toBe('buildings-mismatch');
  });

  it('emits extra-kindoo-calling when Kindoo parens add non-auto callings to an auto seat', () => {
    const result = detect(
      baseInputs({
        seats: [seat({ scope: 'CO', type: 'auto', callings: ['Sunday School Teacher'] })],
        kindooUsers: [
          kuser({ description: 'Cordera Ward (Sunday School Teacher, Building Janitor)' }),
        ],
      }),
    );
    expect(result.discrepancies).toHaveLength(1);
    const row = result.discrepancies[0]!;
    expect(row.code).toBe('extra-kindoo-calling');
    expect(row.severity).toBe('review');
    expect(row.reason).toContain('[Building Janitor]');
    expect(row.reason).toContain('[Sunday School Teacher]');
    expect(row.reason).toContain('add the extra calling(s) to the SBA seat');
  });

  it('extra-kindoo-calling is the only row emitted when scope and type otherwise agree', () => {
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
            building_names: ['Cordera Building'],
          }),
        ],
        kindooUsers: [
          kuser({
            description: 'Cordera Ward (Sunday School Teacher, Accompanist)',
            accessSchedules: [{ ruleId: 6248 }],
          }),
        ],
      }),
    );
    expect(result.discrepancies).toHaveLength(1);
    expect(result.discrepancies[0]?.code).toBe('extra-kindoo-calling');
  });

  it('respects temp override and emits type-mismatch (auto seat vs temp kindoo)', () => {
    const result = detect(
      baseInputs({
        seats: [seat({ type: 'auto' })],
        kindooUsers: [kuser({ isTempUser: true })],
      }),
    );
    expect(result.discrepancies).toHaveLength(1);
    expect(result.discrepancies[0]?.code).toBe('type-mismatch');
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
    const result = detect(
      baseInputs({
        seats: [
          seat({ member_canonical: 'z@example.com', member_email: 'z@example.com' }),
          seat({ member_canonical: 'a@example.com', member_email: 'a@example.com' }),
        ],
        kindooUsers: [
          // extra-kindoo-calling → review
          kuser({
            username: 'z@example.com',
            description: 'Cordera Ward (Sunday School Teacher, Janitor)',
          }),
          // matches SBA on a@example.com → no row
          kuser({ username: 'a@example.com' }),
        ],
      }),
    );
    // a@example.com matches → no row; z@example.com → review row.
    // Plus add an sba-only to confirm drift sorts first.
    const inputs = baseInputs({
      seats: [
        seat({ member_canonical: 'z@example.com', member_email: 'z@example.com' }),
        seat({ member_canonical: 'a@example.com', member_email: 'a@example.com' }),
        seat({ member_canonical: 'b-orphan@example.com', member_email: 'b-orphan@example.com' }),
      ],
      kindooUsers: [
        kuser({
          username: 'z@example.com',
          description: 'Cordera Ward (Sunday School Teacher, Janitor)',
        }),
        kuser({ username: 'a@example.com' }),
      ],
    });
    const sorted = detect(inputs);
    expect(sorted.discrepancies[0]?.code).toBe('sba-only');
    expect(sorted.discrepancies[0]?.displayEmail).toBe('b-orphan@example.com');
    expect(sorted.discrepancies[1]?.code).toBe('extra-kindoo-calling');
    // (suppress unused-var lint on the helper above)
    expect(result).toBeDefined();
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
            building_names: ['Cordera Building'],
          }),
        ],
        kindooUsers: [
          kuser({
            description: 'Cordera Ward (Building Greeter)',
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
            reason: 'Requested by bishop',
            building_names: ['Cordera Building', 'Pine Creek Building'],
          }),
        ],
        kindooUsers: [
          kuser({
            description: 'Cordera Ward (Building Greeter)',
            accessSchedules: [{ ruleId: 6249 }, { ruleId: 6248 }],
          }),
        ],
      }),
    );
    expect(result.discrepancies).toEqual([]);
  });

  it('emits no scope-mismatch when stake segment is non-auto but ward segment auto-matches the seat (corry@corrymac.com shape)', () => {
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
            member_canonical: 'corry@corrymac.com',
            member_email: 'corry@corrymac.com',
            scope: 'CO',
            type: 'auto',
            callings: ['Sunday School Teacher'],
          }),
        ],
        kindooUsers: [
          kuser({
            username: 'corry@corrymac.com',
            description:
              'Colorado Springs North Stake (Technology Specialist)  |  Cordera Ward (Sunday School Teacher)',
            accessSchedules: [{ ruleId: 6248 }],
          }),
        ],
      }),
    );
    const rowsForEmail = result.discrepancies.filter((d) => d.canonical === 'corry@corrymac.com');
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
});
