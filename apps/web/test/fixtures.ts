// Factory helpers for unit / component tests. Centralises the shape of
// `Seat`, `AccessRequest`, etc. so a Phase-5 schema field addition only
// needs to be added in one place rather than every test file.

import type { Access, AccessRequest, AuditLog, Seat, TimestampLike, Ward } from '@kindoo/shared';

const NOW_DATE = new Date('2026-04-28T12:00:00Z');
const NOW: TimestampLike = {
  seconds: Math.floor(NOW_DATE.getTime() / 1000),
  nanoseconds: 0,
  toDate: () => NOW_DATE,
  toMillis: () => NOW_DATE.getTime(),
};
const FAKE_ACTOR = { email: 'manager@example.com', canonical: 'manager@example.com' } as const;

export function makeSeat(overrides: Partial<Seat> = {}): Seat {
  return {
    member_canonical: 'alice@example.com',
    member_email: 'alice@example.com',
    member_name: 'Alice Example',
    scope: 'CO',
    type: 'auto',
    callings: ['Bishop'],
    building_names: ['North Building'],
    duplicate_grants: [],
    created_at: NOW,
    last_modified_at: NOW,
    last_modified_by: FAKE_ACTOR,
    lastActor: FAKE_ACTOR,
    ...overrides,
  } satisfies Seat;
}

export function makeRequest(overrides: Partial<AccessRequest> = {}): AccessRequest {
  return {
    request_id: 'req-1',
    type: 'add_manual',
    scope: 'CO',
    member_email: 'bob@example.com',
    member_canonical: 'bob@example.com',
    member_name: 'Bob Example',
    reason: 'Sub Sunday teacher',
    comment: '',
    building_names: [],
    status: 'pending',
    requester_email: 'bishop@example.com',
    requester_canonical: 'bishop@example.com',
    requested_at: NOW,
    lastActor: { email: 'bishop@example.com', canonical: 'bishop@example.com' },
    ...overrides,
  } satisfies AccessRequest;
}

export function makeWard(overrides: Partial<Ward> = {}): Ward {
  return {
    ward_code: 'CO',
    ward_name: 'Cordera',
    building_name: 'North Building',
    seat_cap: 20,
    created_at: NOW,
    last_modified_at: NOW,
    lastActor: FAKE_ACTOR,
    ...overrides,
  } satisfies Ward;
}

export function makeAccess(overrides: Partial<Access> = {}): Access {
  return {
    member_canonical: 'alice@example.com',
    member_email: 'alice@example.com',
    member_name: 'Alice Example',
    importer_callings: { CO: ['Bishop'] },
    manual_grants: {},
    created_at: NOW,
    last_modified_at: NOW,
    last_modified_by: FAKE_ACTOR,
    lastActor: FAKE_ACTOR,
    ...overrides,
  } satisfies Access;
}

export function makeAuditLog(overrides: Partial<AuditLog> = {}): AuditLog {
  return {
    audit_id: '2026-04-28T12-00-00-000Z_abcd',
    timestamp: NOW,
    actor_email: 'manager@example.com',
    actor_canonical: 'manager@example.com',
    action: 'create_seat',
    entity_type: 'seat',
    entity_id: 'alice@example.com',
    member_canonical: 'alice@example.com',
    before: null,
    after: { member_email: 'alice@example.com', scope: 'CO', type: 'auto' },
    ttl: NOW,
    ...overrides,
  } satisfies AuditLog;
}
