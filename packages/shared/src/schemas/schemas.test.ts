// Round-trip schema tests — one representative seed doc per collection
// (per `firebase-migration.md` Phase 3 Tests, "zod schema parses for
// representative documents in each collection. Round-trip via
// `schema.parse(seedDoc)`.").
//
// We construct each fixture with the structural `TimestampLike` shape
// the runtime never actually produces directly — Firestore's
// `Timestamp` does, and a hand-rolled stand-in suffices in tests
// because the schema never exercises the methods.
//
// The intent is twofold:
//   1. A seed doc that exercises every required field round-trips
//      cleanly (no schema bug; no accidental over-strict refinement).
//   2. A representative bad-shape input fails parse — validates the
//      schema is doing real checking, not just `z.any()`.

import { describe, expect, it } from 'vitest';
import {
  accessRequestSchema,
  accessSchema,
  auditLogSchema,
  buildingSchema,
  callingTemplateSchema,
  kindooManagerSchema,
  manualGrantSchema,
  platformAuditLogSchema,
  platformSuperadminSchema,
  seatSchema,
  stakeSchema,
  userIndexEntrySchema,
  wardSchema,
} from './index.js';

/** Minimal stand-in that satisfies the structural `TimestampLike` schema. */
function fakeTs(iso: string): {
  seconds: number;
  nanoseconds: number;
  toDate: () => Date;
  toMillis: () => number;
} {
  const d = new Date(iso);
  const ms = d.getTime();
  return {
    seconds: Math.floor(ms / 1000),
    nanoseconds: (ms % 1000) * 1_000_000,
    toDate: () => d,
    toMillis: () => ms,
  };
}

const ACTOR = { email: 'Alice@gmail.com', canonical: 'alice@gmail.com' };
const T = fakeTs('2026-04-28T14:23:45.123Z');

describe('userIndexEntrySchema', () => {
  it('parses a representative entry', () => {
    const seed = { uid: 'firebase-uid-1', typedEmail: 'Alice@gmail.com', lastSignIn: T };
    expect(userIndexEntrySchema.parse(seed)).toEqual(seed);
  });

  it('rejects missing uid', () => {
    expect(() => userIndexEntrySchema.parse({ typedEmail: 'a@b.com', lastSignIn: T })).toThrow();
  });
});

describe('platformSuperadminSchema', () => {
  it('parses a representative entry', () => {
    const seed = {
      email: 'admin@kindoo.example',
      addedAt: T,
      addedBy: 'self@kindoo.example',
      notes: 'bootstrap',
    };
    expect(platformSuperadminSchema.parse(seed)).toEqual(seed);
  });

  it('parses without optional notes', () => {
    const seed = { email: 'a@b.com', addedAt: T, addedBy: 'self@b.com' };
    expect(platformSuperadminSchema.parse(seed)).toEqual(seed);
  });
});

describe('platformAuditLogSchema', () => {
  it('parses a representative entry', () => {
    const seed = {
      timestamp: T,
      actor_email: 'Admin@kindoo.example',
      actor_canonical: 'admin@kindoo.example',
      action: 'create_stake' as const,
      entity_type: 'stake' as const,
      entity_id: 'csnorth',
      before: null,
      after: { stake_id: 'csnorth' },
      ttl: T,
    };
    expect(platformAuditLogSchema.parse(seed)).toEqual(seed);
  });
});

describe('stakeSchema', () => {
  it('parses a representative entry', () => {
    const seed = {
      stake_id: 'csnorth',
      stake_name: 'CS North Stake',
      created_at: T,
      created_by: 'admin@kindoo.example',
      callings_sheet_id: '1abcXYZ',
      bootstrap_admin_email: 'Bishop@example.org',
      setup_complete: true,
      stake_seat_cap: 250,
      expiry_hour: 4,
      import_day: 'MONDAY' as const,
      import_hour: 6,
      timezone: 'America/Denver',
      notifications_enabled: true,
      last_over_caps_json: [],
      last_modified_at: T,
      last_modified_by: ACTOR,
      lastActor: ACTOR,
    };
    expect(stakeSchema.parse(seed)).toEqual(seed);
  });

  it('parses with the optional last_* operational fields populated', () => {
    const seed = {
      stake_id: 'csnorth',
      stake_name: 'CS North Stake',
      created_at: T,
      created_by: 'admin@kindoo.example',
      callings_sheet_id: '1abcXYZ',
      bootstrap_admin_email: 'Bishop@example.org',
      setup_complete: true,
      stake_seat_cap: 250,
      expiry_hour: 4,
      import_day: 'TUESDAY' as const,
      import_hour: 6,
      timezone: 'America/Denver',
      notifications_enabled: false,
      last_over_caps_json: [{ pool: 'stake', count: 251, cap: 250, over_by: 1 }],
      last_import_at: T,
      last_import_summary: 'Imported 240 callings (5 inserted, 0 deleted).',
      last_expiry_at: T,
      last_expiry_summary: 'Expired 0 temp seats.',
      last_modified_at: T,
      last_modified_by: ACTOR,
      lastActor: ACTOR,
    };
    expect(stakeSchema.parse(seed)).toEqual(seed);
  });

  it('rejects an out-of-range expiry_hour', () => {
    const seed = {
      stake_id: 'csnorth',
      stake_name: 'CS North Stake',
      created_at: T,
      created_by: 'admin@kindoo.example',
      callings_sheet_id: '1abcXYZ',
      bootstrap_admin_email: 'Bishop@example.org',
      setup_complete: true,
      stake_seat_cap: 250,
      expiry_hour: 27,
      import_day: 'MONDAY' as const,
      import_hour: 6,
      timezone: 'America/Denver',
      notifications_enabled: true,
      last_over_caps_json: [],
      last_modified_at: T,
      last_modified_by: ACTOR,
      lastActor: ACTOR,
    };
    expect(() => stakeSchema.parse(seed)).toThrow();
  });
});

describe('wardSchema', () => {
  it('parses a representative entry', () => {
    const seed = {
      ward_code: '01',
      ward_name: '1st Ward',
      building_name: 'Cordera Building',
      seat_cap: 30,
      created_at: T,
      last_modified_at: T,
      lastActor: ACTOR,
    };
    expect(wardSchema.parse(seed)).toEqual(seed);
  });
});

describe('buildingSchema', () => {
  it('parses a representative entry', () => {
    const seed = {
      building_id: 'cordera-building',
      building_name: 'Cordera Building',
      address: '1234 Cordera Cir',
      created_at: T,
      last_modified_at: T,
      lastActor: ACTOR,
    };
    expect(buildingSchema.parse(seed)).toEqual(seed);
  });
});

describe('kindooManagerSchema', () => {
  it('parses a representative entry', () => {
    const seed = {
      member_canonical: 'alice@gmail.com',
      member_email: 'Alice@gmail.com',
      name: 'Alice Smith',
      active: true,
      added_at: T,
      added_by: ACTOR,
      lastActor: ACTOR,
    };
    expect(kindooManagerSchema.parse(seed)).toEqual(seed);
  });
});

describe('manualGrantSchema', () => {
  it('parses a representative entry', () => {
    const seed = {
      grant_id: '11111111-2222-3333-4444-555555555555',
      reason: 'Visiting authority — temporary stake-scope access',
      granted_by: ACTOR,
      granted_at: T,
    };
    expect(manualGrantSchema.parse(seed)).toEqual(seed);
  });
});

describe('accessSchema', () => {
  it('parses a representative entry with both importer and manual sides populated', () => {
    const seed = {
      member_canonical: 'alice@gmail.com',
      member_email: 'Alice@gmail.com',
      member_name: 'Alice Smith',
      importer_callings: { stake: ['Stake Clerk'], '01': ['Bishop'] },
      manual_grants: {
        stake: [
          {
            grant_id: '11111111-2222-3333-4444-555555555555',
            reason: 'one-time stake-scope grant',
            granted_by: ACTOR,
            granted_at: T,
          },
        ],
      },
      created_at: T,
      last_modified_at: T,
      last_modified_by: ACTOR,
      lastActor: ACTOR,
    };
    expect(accessSchema.parse(seed)).toEqual(seed);
  });

  it('parses with both maps empty (an access doc on the brink of deletion)', () => {
    const seed = {
      member_canonical: 'alice@gmail.com',
      member_email: 'Alice@gmail.com',
      member_name: 'Alice Smith',
      importer_callings: {},
      manual_grants: {},
      created_at: T,
      last_modified_at: T,
      last_modified_by: ACTOR,
      lastActor: ACTOR,
    };
    expect(accessSchema.parse(seed)).toEqual(seed);
  });
});

describe('seatSchema', () => {
  it('parses a representative auto seat (multi-calling collapse case)', () => {
    const seed = {
      member_canonical: 'alice@gmail.com',
      member_email: 'Alice@gmail.com',
      member_name: 'Alice Smith',
      scope: 'stake',
      type: 'auto' as const,
      callings: ['Stake Clerk', 'Stake YM Counselor'],
      building_names: ['Cordera Building'],
      duplicate_grants: [],
      created_at: T,
      last_modified_at: T,
      last_modified_by: ACTOR,
      lastActor: ACTOR,
    };
    expect(seatSchema.parse(seed)).toEqual(seed);
  });

  it('parses a representative temp seat with start_date / end_date / granted_by_request', () => {
    const seed = {
      member_canonical: 'bob@gmail.com',
      member_email: 'Bob@gmail.com',
      member_name: 'Bob Brown',
      scope: '01',
      type: 'temp' as const,
      callings: [],
      reason: 'Visiting speaker',
      start_date: '2026-05-01',
      end_date: '2026-05-08',
      building_names: ['Cordera Building'],
      granted_by_request: 'request-uuid-1',
      duplicate_grants: [],
      created_at: T,
      last_modified_at: T,
      last_modified_by: ACTOR,
      lastActor: ACTOR,
    };
    expect(seatSchema.parse(seed)).toEqual(seed);
  });

  it('rejects a malformed start_date (non YYYY-MM-DD)', () => {
    const bad = {
      member_canonical: 'b@gmail.com',
      member_email: 'b@gmail.com',
      member_name: 'B',
      scope: '01',
      type: 'temp' as const,
      callings: [],
      reason: 'X',
      start_date: '5/1/2026', // wrong shape
      end_date: '2026-05-08',
      building_names: [],
      granted_by_request: 'r1',
      duplicate_grants: [],
      created_at: T,
      last_modified_at: T,
      last_modified_by: ACTOR,
      lastActor: ACTOR,
    };
    expect(() => seatSchema.parse(bad)).toThrow();
  });

  it('parses a manual seat with a duplicate-grant collision recorded', () => {
    const seed = {
      member_canonical: 'alice@gmail.com',
      member_email: 'Alice@gmail.com',
      member_name: 'Alice Smith',
      scope: 'stake',
      type: 'manual' as const,
      callings: [],
      reason: 'Visiting authority',
      building_names: ['Cordera Building'],
      granted_by_request: 'request-uuid-2',
      duplicate_grants: [
        {
          scope: '01',
          type: 'auto' as const,
          callings: ['Bishop'],
          detected_at: T,
        },
      ],
      created_at: T,
      last_modified_at: T,
      last_modified_by: ACTOR,
      lastActor: ACTOR,
    };
    expect(seatSchema.parse(seed)).toEqual(seed);
  });
});

describe('accessRequestSchema', () => {
  it('parses a representative pending add_temp request', () => {
    const seed = {
      request_id: 'req-1',
      type: 'add_temp' as const,
      scope: 'stake',
      member_email: 'Bob@gmail.com',
      member_canonical: 'bob@gmail.com',
      member_name: 'Bob Brown',
      reason: 'Visiting speaker',
      comment: 'In town May 1–8',
      start_date: '2026-05-01',
      end_date: '2026-05-08',
      building_names: ['Cordera Building'],
      status: 'pending' as const,
      requester_email: 'Alice@gmail.com',
      requester_canonical: 'alice@gmail.com',
      requested_at: T,
      lastActor: ACTOR,
    };
    expect(accessRequestSchema.parse(seed)).toEqual(seed);
  });

  it('parses a representative completed remove request', () => {
    const seed = {
      request_id: 'req-2',
      type: 'remove' as const,
      scope: '01',
      member_email: 'Bob@gmail.com',
      member_canonical: 'bob@gmail.com',
      member_name: 'Bob Brown',
      reason: 'No longer needed',
      comment: '',
      building_names: [],
      status: 'complete' as const,
      requester_email: 'Alice@gmail.com',
      requester_canonical: 'alice@gmail.com',
      requested_at: T,
      completer_email: 'Mgr@gmail.com',
      completer_canonical: 'mgr@gmail.com',
      completed_at: T,
      seat_member_canonical: 'bob@gmail.com',
      lastActor: ACTOR,
    };
    expect(accessRequestSchema.parse(seed)).toEqual(seed);
  });

  it('parses a rejected request with a rejection_reason', () => {
    const seed = {
      request_id: 'req-3',
      type: 'add_manual' as const,
      scope: 'stake',
      member_email: 'C@gmail.com',
      member_canonical: 'c@gmail.com',
      member_name: 'Carol',
      reason: 'long-term grant',
      comment: '',
      building_names: ['Cordera Building'],
      status: 'rejected' as const,
      requester_email: 'Alice@gmail.com',
      requester_canonical: 'alice@gmail.com',
      requested_at: T,
      completer_email: 'Mgr@gmail.com',
      completer_canonical: 'mgr@gmail.com',
      completed_at: T,
      rejection_reason: 'Insufficient justification',
      lastActor: ACTOR,
    };
    expect(accessRequestSchema.parse(seed)).toEqual(seed);
  });

  it('parses a remove that was a no-op (R-1 race) with completion_note', () => {
    const seed = {
      request_id: 'req-4',
      type: 'remove' as const,
      scope: '01',
      member_email: 'D@gmail.com',
      member_canonical: 'd@gmail.com',
      member_name: 'Dave',
      reason: 'No longer needed',
      comment: '',
      building_names: [],
      status: 'complete' as const,
      requester_email: 'Alice@gmail.com',
      requester_canonical: 'alice@gmail.com',
      requested_at: T,
      completer_email: 'Mgr@gmail.com',
      completer_canonical: 'mgr@gmail.com',
      completed_at: T,
      completion_note: 'Seat already removed at completion time (no-op).',
      seat_member_canonical: 'd@gmail.com',
      lastActor: ACTOR,
    };
    expect(accessRequestSchema.parse(seed)).toEqual(seed);
  });
});

describe('callingTemplateSchema', () => {
  it('parses a representative ward template entry', () => {
    const seed = {
      calling_name: 'Bishop',
      give_app_access: true,
      sheet_order: 1,
      created_at: T,
      lastActor: ACTOR,
    };
    expect(callingTemplateSchema.parse(seed)).toEqual(seed);
  });

  it('parses a wildcard template entry', () => {
    const seed = {
      calling_name: 'Counselor *',
      give_app_access: false,
      sheet_order: 14,
      created_at: T,
      lastActor: ACTOR,
    };
    expect(callingTemplateSchema.parse(seed)).toEqual(seed);
  });
});

describe('auditLogSchema', () => {
  it('parses a representative seat-create row', () => {
    const seed = {
      audit_id: '2026-04-28T14:23:45.123Z_seats_alice@gmail.com',
      timestamp: T,
      actor_email: 'Mgr@gmail.com',
      actor_canonical: 'mgr@gmail.com',
      action: 'create_seat' as const,
      entity_type: 'seat' as const,
      entity_id: 'alice@gmail.com',
      member_canonical: 'alice@gmail.com',
      before: null,
      after: { scope: 'stake', type: 'manual' },
      ttl: T,
    };
    expect(auditLogSchema.parse(seed)).toEqual(seed);
  });

  it('parses a system-action row (no member_canonical)', () => {
    const seed = {
      audit_id: '2026-04-28T14:23:45.123Z_system_import-1',
      timestamp: T,
      actor_email: 'Importer',
      actor_canonical: 'Importer',
      action: 'import_start' as const,
      entity_type: 'system' as const,
      entity_id: 'import-1',
      before: null,
      after: { stake_id: 'csnorth' },
      ttl: T,
    };
    expect(auditLogSchema.parse(seed)).toEqual(seed);
  });

  it('rejects an unknown action', () => {
    const bad = {
      audit_id: '2026-04-28T14:23:45.123Z_x',
      timestamp: T,
      actor_email: 'A',
      actor_canonical: 'a',
      action: 'frobnicate',
      entity_type: 'seat',
      entity_id: 'x',
      before: null,
      after: null,
      ttl: T,
    };
    expect(() => auditLogSchema.parse(bad)).toThrow();
  });
});
