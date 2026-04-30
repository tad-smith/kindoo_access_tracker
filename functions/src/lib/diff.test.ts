// Unit tests for the importer diff planner. Pure-function — no
// Firestore involvement. Covers priority math, importer/manual
// split-ownership preservation, and over-cap-adjacent multi-calling
// collapse.

import { describe, expect, it } from 'vitest';
import { pickPrimaryScope, planDiff } from './diff.js';
import type { ParsedRow } from './parser.js';
import type { Access, Seat } from '@kindoo/shared';

const META = {
  wardBuildings: new Map<string, string[]>([
    ['CO', ['Cordera Building']],
    ['BR', ['Briargate Building']],
  ]),
  stakeBuildings: ['Cordera Building', 'Briargate Building'],
  wardCodes: new Set(['CO', 'BR']),
};

describe('pickPrimaryScope', () => {
  it('stake outranks all wards', () => {
    expect(pickPrimaryScope(['BR', 'stake', 'CO'])).toBe('stake');
  });
  it('among wards, alphabetical ascending', () => {
    expect(pickPrimaryScope(['CO', 'BR'])).toBe('BR');
    expect(pickPrimaryScope(['XX', 'AA', 'MM'])).toBe('AA');
  });
  it('single scope returns itself', () => {
    expect(pickPrimaryScope(['CO'])).toBe('CO');
  });
});

const SCOPES_SEEN = new Set(['stake', 'CO', 'BR']);
const EMPTY_STATE = {
  accessByCanonical: new Map<string, Access>(),
  seatsByCanonical: new Map<string, Seat>(),
};

const row = (overrides: Partial<ParsedRow> = {}): ParsedRow => ({
  scope: 'CO',
  calling: 'Bishop',
  email: 'alice@gmail.com',
  name: 'Alice',
  giveAppAccess: true,
  ...overrides,
});

describe('planDiff', () => {
  it('empty parsed rows + empty state → no writes', () => {
    const plan = planDiff({
      parsedRows: [],
      scopesSeen: SCOPES_SEEN,
      current: EMPTY_STATE,
      scopeMeta: META,
    });
    expect(plan.accessUpserts).toEqual([]);
    expect(plan.accessDeletes).toEqual([]);
    expect(plan.seatWrites).toEqual([]);
  });

  it('one parsed row → one access upsert + one auto seat upsert', () => {
    const plan = planDiff({
      parsedRows: [row()],
      scopesSeen: SCOPES_SEEN,
      current: EMPTY_STATE,
      scopeMeta: META,
    });
    expect(plan.accessUpserts).toHaveLength(1);
    expect(plan.accessUpserts[0]!.canonical).toBe('alice@gmail.com');
    expect(plan.accessUpserts[0]!.importer_callings).toEqual({ CO: ['Bishop'] });
    expect(plan.seatWrites).toHaveLength(1);
    const w = plan.seatWrites[0]!;
    expect(w.kind).toBe('auto-upsert');
    if (w.kind !== 'auto-upsert') throw new Error('expected auto-upsert');
    expect(w.seat.scope).toBe('CO');
    expect(w.seat.callings).toEqual(['Bishop']);
    expect(w.seat.building_names).toEqual(['Cordera Building']);
  });

  it('multi-calling person → one seat doc with multiple callings', () => {
    const plan = planDiff({
      parsedRows: [
        row({ calling: 'Bishop' }),
        row({ calling: 'High Councilor', scope: 'CO', email: 'alice@gmail.com', name: 'Alice' }),
      ],
      scopesSeen: SCOPES_SEEN,
      current: EMPTY_STATE,
      scopeMeta: META,
    });
    expect(plan.seatWrites).toHaveLength(1);
    const w = plan.seatWrites[0]!;
    if (w.kind !== 'auto-upsert') throw new Error('expected auto-upsert');
    expect(w.seat.callings.sort()).toEqual(['Bishop', 'High Councilor']);
  });

  it('cross-scope (stake + ward) → primary is stake, ward goes to duplicate_grants', () => {
    const plan = planDiff({
      parsedRows: [
        row({ scope: 'stake', calling: 'Stake President' }),
        row({ scope: 'CO', calling: 'Bishop' }),
      ],
      scopesSeen: SCOPES_SEEN,
      current: EMPTY_STATE,
      scopeMeta: META,
    });
    const w = plan.seatWrites[0]!;
    if (w.kind !== 'auto-upsert') throw new Error('expected auto-upsert');
    expect(w.seat.scope).toBe('stake');
    expect(w.seat.callings).toEqual(['Stake President']);
    expect(w.seat.duplicate_grants).toHaveLength(1);
    expect(w.seat.duplicate_grants[0]!.scope).toBe('CO');
    expect(w.seat.duplicate_grants[0]!.callings).toEqual(['Bishop']);
  });

  it('idempotency — same parsed rows + matching current state → no writes', () => {
    const seat: Seat = {
      member_canonical: 'alice@gmail.com',
      member_email: 'alice@gmail.com',
      member_name: 'Alice',
      scope: 'CO',
      type: 'auto',
      callings: ['Bishop'],
      building_names: ['Cordera Building'],
      duplicate_grants: [],
      created_at: null as unknown as Seat['created_at'],
      last_modified_at: null as unknown as Seat['last_modified_at'],
      last_modified_by: { email: 'Importer', canonical: 'Importer' },
      lastActor: { email: 'Importer', canonical: 'Importer' },
    };
    const access: Access = {
      member_canonical: 'alice@gmail.com',
      member_email: 'alice@gmail.com',
      member_name: 'Alice',
      importer_callings: { CO: ['Bishop'] },
      manual_grants: {},
      created_at: null as unknown as Access['created_at'],
      last_modified_at: null as unknown as Access['last_modified_at'],
      last_modified_by: { email: 'Importer', canonical: 'Importer' },
      lastActor: { email: 'Importer', canonical: 'Importer' },
    };
    const plan = planDiff({
      parsedRows: [row()],
      scopesSeen: SCOPES_SEEN,
      current: {
        accessByCanonical: new Map([['alice@gmail.com', access]]),
        seatsByCanonical: new Map([['alice@gmail.com', seat]]),
      },
      scopeMeta: META,
    });
    // Access upsert: still emitted because we always restate the doc (the
    // applier short-circuits on byte-equal writes via merge). For this
    // test, we check the value matches what is already there.
    expect(plan.accessUpserts).toHaveLength(1);
    expect(plan.accessUpserts[0]!.importer_callings).toEqual({ CO: ['Bishop'] });
    // Seat: byte-equal → no seatWrites entry.
    expect(plan.seatWrites).toEqual([]);
  });

  it('manual_grants are preserved on access upsert', () => {
    const access: Access = {
      member_canonical: 'alice@gmail.com',
      member_email: 'alice@gmail.com',
      member_name: 'Alice',
      importer_callings: { CO: ['Bishop'] },
      manual_grants: {
        BR: [
          {
            grant_id: 'g1',
            reason: 'Helping out',
            granted_by: { email: 'mgr@gmail.com', canonical: 'mgr@gmail.com' },
            granted_at: null as unknown as Access['manual_grants'][string][number]['granted_at'],
          },
        ],
      },
      created_at: null as unknown as Access['created_at'],
      last_modified_at: null as unknown as Access['last_modified_at'],
      last_modified_by: { email: 'Importer', canonical: 'Importer' },
      lastActor: { email: 'Importer', canonical: 'Importer' },
    };
    const plan = planDiff({
      parsedRows: [row({ calling: 'Bishopric Secretary' })],
      scopesSeen: SCOPES_SEEN,
      current: {
        accessByCanonical: new Map([['alice@gmail.com', access]]),
        seatsByCanonical: new Map(),
      },
      scopeMeta: META,
    });
    // The diff plan never sets manual_grants — applier merges. We verify
    // the access doc is in `accessUpserts`, not `accessDeletes`.
    expect(plan.accessUpserts).toHaveLength(1);
    expect(plan.accessDeletes).toEqual([]);
    expect(plan.accessUpserts[0]!.importer_callings).toEqual({ CO: ['Bishopric Secretary'] });
  });

  it('all importer rows gone + no manual grants → access delete', () => {
    const access: Access = {
      member_canonical: 'alice@gmail.com',
      member_email: 'alice@gmail.com',
      member_name: 'Alice',
      importer_callings: { CO: ['Bishop'] },
      manual_grants: {},
      created_at: null as unknown as Access['created_at'],
      last_modified_at: null as unknown as Access['last_modified_at'],
      last_modified_by: { email: 'Importer', canonical: 'Importer' },
      lastActor: { email: 'Importer', canonical: 'Importer' },
    };
    const plan = planDiff({
      parsedRows: [],
      scopesSeen: SCOPES_SEEN,
      current: {
        accessByCanonical: new Map([['alice@gmail.com', access]]),
        seatsByCanonical: new Map(),
      },
      scopeMeta: META,
    });
    expect(plan.accessDeletes).toEqual([{ canonical: 'alice@gmail.com' }]);
    expect(plan.accessUpserts).toEqual([]);
  });

  it('all importer rows gone but manual grants remain → upsert with empty importer_callings', () => {
    const access: Access = {
      member_canonical: 'alice@gmail.com',
      member_email: 'alice@gmail.com',
      member_name: 'Alice',
      importer_callings: { CO: ['Bishop'] },
      manual_grants: {
        BR: [
          {
            grant_id: 'g1',
            reason: 'Helping out',
            granted_by: { email: 'mgr@gmail.com', canonical: 'mgr@gmail.com' },
            granted_at: null as unknown as Access['manual_grants'][string][number]['granted_at'],
          },
        ],
      },
      created_at: null as unknown as Access['created_at'],
      last_modified_at: null as unknown as Access['last_modified_at'],
      last_modified_by: { email: 'Importer', canonical: 'Importer' },
      lastActor: { email: 'Importer', canonical: 'Importer' },
    };
    const plan = planDiff({
      parsedRows: [],
      scopesSeen: SCOPES_SEEN,
      current: {
        accessByCanonical: new Map([['alice@gmail.com', access]]),
        seatsByCanonical: new Map(),
      },
      scopeMeta: META,
    });
    expect(plan.accessUpserts).toHaveLength(1);
    expect(plan.accessUpserts[0]!.importer_callings).toEqual({});
    expect(plan.accessDeletes).toEqual([]);
  });

  it('scope NOT seen this run → preserves importer_callings for that scope', () => {
    const access: Access = {
      member_canonical: 'alice@gmail.com',
      member_email: 'alice@gmail.com',
      member_name: 'Alice',
      importer_callings: { ZZ: ['Old Calling'] }, // ZZ not in scopesSeen
      manual_grants: {},
      created_at: null as unknown as Access['created_at'],
      last_modified_at: null as unknown as Access['last_modified_at'],
      last_modified_by: { email: 'Importer', canonical: 'Importer' },
      lastActor: { email: 'Importer', canonical: 'Importer' },
    };
    const plan = planDiff({
      parsedRows: [],
      scopesSeen: SCOPES_SEEN, // does NOT include ZZ
      current: {
        accessByCanonical: new Map([['alice@gmail.com', access]]),
        seatsByCanonical: new Map(),
      },
      scopeMeta: META,
    });
    expect(plan.accessUpserts).toHaveLength(1);
    expect(plan.accessUpserts[0]!.importer_callings).toEqual({ ZZ: ['Old Calling'] });
  });

  it('manual seat exists + importer finds auto callings → duplicates-update on the manual seat', () => {
    const seat: Seat = {
      member_canonical: 'alice@gmail.com',
      member_email: 'alice@gmail.com',
      member_name: 'Alice',
      scope: 'BR',
      type: 'manual',
      callings: [],
      reason: 'helper',
      building_names: ['Briargate Building'],
      duplicate_grants: [],
      granted_by_request: 'req-1',
      created_at: null as unknown as Seat['created_at'],
      last_modified_at: null as unknown as Seat['last_modified_at'],
      last_modified_by: { email: 'mgr@gmail.com', canonical: 'mgr@gmail.com' },
      lastActor: { email: 'mgr@gmail.com', canonical: 'mgr@gmail.com' },
    };
    const plan = planDiff({
      parsedRows: [row({ scope: 'CO', calling: 'Bishop' })],
      scopesSeen: SCOPES_SEEN,
      current: {
        accessByCanonical: new Map(),
        seatsByCanonical: new Map([['alice@gmail.com', seat]]),
      },
      scopeMeta: META,
    });
    expect(plan.seatWrites).toHaveLength(1);
    const w = plan.seatWrites[0]!;
    expect(w.kind).toBe('duplicates-update');
    if (w.kind !== 'duplicates-update') throw new Error('expected duplicates-update');
    expect(w.duplicate_grants.some((d) => d.type === 'auto' && d.scope === 'CO')).toBe(true);
  });

  it('current auto seat in scope-seen + no longer in source → auto-delete', () => {
    const seat: Seat = {
      member_canonical: 'alice@gmail.com',
      member_email: 'alice@gmail.com',
      member_name: 'Alice',
      scope: 'CO',
      type: 'auto',
      callings: ['Bishop'],
      building_names: ['Cordera Building'],
      duplicate_grants: [],
      created_at: null as unknown as Seat['created_at'],
      last_modified_at: null as unknown as Seat['last_modified_at'],
      last_modified_by: { email: 'Importer', canonical: 'Importer' },
      lastActor: { email: 'Importer', canonical: 'Importer' },
    };
    const plan = planDiff({
      parsedRows: [],
      scopesSeen: SCOPES_SEEN,
      current: {
        accessByCanonical: new Map(),
        seatsByCanonical: new Map([['alice@gmail.com', seat]]),
      },
      scopeMeta: META,
    });
    expect(plan.seatWrites).toEqual([{ kind: 'auto-delete', canonical: 'alice@gmail.com' }]);
  });
});
