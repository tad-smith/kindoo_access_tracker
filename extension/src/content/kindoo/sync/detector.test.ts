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
            building_names: ['Cordera Building'],
          }),
        ],
        kindooUsers: [
          kuser({
            username: 'auto-user@example.com',
            description: 'Cordera Ward (Sunday School Teacher)',
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
            building_names: ['Cordera Building'],
          }),
        ],
        kindooUsers: [
          kuser({
            username: 'auto-match@example.com',
            description: 'Cordera Ward (Sunday School Teacher)',
            accessSchedules: [],
            derivedBuildings: ['Cordera Building'],
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
            building_names: ['Cordera Building'],
          }),
        ],
        kindooUsers: [
          kuser({
            username: 'auto-diff@example.com',
            description: 'Cordera Ward (Sunday School Teacher)',
            accessSchedules: [],
            derivedBuildings: ['Cordera Building', 'Pine Creek Building'],
          }),
        ],
      }),
    );
    expect(result.discrepancies).toHaveLength(1);
    expect(result.discrepancies[0]?.code).toBe('buildings-mismatch');
    expect(result.discrepancies[0]?.reason).toContain('Cordera Building, Pine Creek Building');
    // KindooBlock surfaces derivedBuildings so the fix dispatcher and
    // the row UI can use it.
    expect(result.discrepancies[0]?.kindoo?.derivedBuildings).toEqual([
      'Cordera Building',
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
            building_names: ['Cordera Building'],
          }),
        ],
        kindooUsers: [
          kuser({
            username: 'auto-empty@example.com',
            description: 'Cordera Ward (Sunday School Teacher)',
            accessSchedules: [],
            derivedBuildings: [],
          }),
        ],
      }),
    );
    expect(result.discrepancies).toHaveLength(1);
    expect(result.discrepancies[0]?.code).toBe('buildings-mismatch');
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

  // --------------------------------------------------------------------
  // Phase 4 — active-site filter. The detector filters both sides of
  // the diff to seats / users belonging to the active Kindoo site. See
  // `content/kindoo/sync/activeSite.ts` + `docs/spec.md` §15.
  // --------------------------------------------------------------------

  // Mixed home + foreign fixture. Two wards: Cordera (home) and Foothills
  // (foreign-site 'east-stake'). Plus stake-scope seats and Kindoo users
  // on each side.
  const WARDS_MIXED: Ward[] = [
    ward('CO', 'Cordera Ward', 'Cordera Building'),
    {
      ...ward('FT', 'Foothills Ward', 'Foothills Building'),
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
            description: 'Cordera Ward (Sunday School Teacher)',
          }),
          kuser({
            username: 'foreign-user@example.com',
            description: 'Foothills Ward (Sunday School Teacher)',
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
            description: 'Cordera Ward (Sunday School Teacher)',
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
    // Multi-site user: Bishop in Cordera (home) + Sunday School Teacher
    // in Foothills (foreign). Seat carries the home primary + a foreign
    // duplicate. Description carries both segments.
    const multiSeat = seat({
      member_canonical: 'multi@example.com',
      member_email: 'multi@example.com',
      member_name: 'Multi Site',
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
          detected_at: ts(),
        },
      ],
    });
    const multiKuser = kuser({
      euid: 'e-multi',
      userId: 'u-multi',
      username: 'multi@example.com',
      description: 'Cordera Ward (Sunday School Teacher) | Foothills Ward (Sunday School Teacher)',
      accessSchedules: [{ ruleId: 6248 }, { ruleId: 6249 }],
    });

    // Home view: expects Cordera (rule 6248). The home segment matches
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

    // Foreign view: expects Foothills (rule 6249). The foreign segment
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
    // Stake Clerk + Sunday School Teacher in Foothills (foreign). Seat:
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
      building_names: ['Cordera Building'],
      kindoo_site_id: null,
      duplicate_grants: [
        {
          scope: 'FT',
          type: 'auto',
          callings: ['Sunday School Teacher'],
          building_names: ['Foothills Building'],
          kindoo_site_id: 'east-stake',
          detected_at: ts(),
        },
      ],
    });
    const multiKuser = kuser({
      euid: 'e-sc',
      userId: 'u-sc',
      username: 'sc@example.com',
      description:
        'Colorado Springs North Stake (Stake Clerk) | Foothills Ward (Sunday School Teacher)',
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

    // Foreign view: picks the Foothills segment and matches the seat's
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
      building_names: ['Cordera Building'],
      duplicate_grants: [
        {
          scope: 'FT',
          type: 'auto',
          callings: ['Sunday School Teacher'],
          building_names: ['Foothills Building'],
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
    expect(result.discrepancies[0]!.sba?.buildingNames).toEqual(['Foothills Building']);
  });
});
