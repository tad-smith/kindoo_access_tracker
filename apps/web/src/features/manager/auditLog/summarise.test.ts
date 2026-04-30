// Unit tests for the audit-row summary + field-diff helpers.

import { describe, expect, it } from 'vitest';
import { Timestamp } from 'firebase/firestore';
import {
  auditActionCategory,
  computeFieldDiff,
  diffKeys,
  formatDiffValue,
  summariseAuditRow,
} from './summarise';
import { makeAuditLog } from '../../../../test/fixtures';

describe('summariseAuditRow', () => {
  it('surfaces completion_note prose on R-1 complete_request rows', () => {
    const row = makeAuditLog({
      action: 'complete_request',
      after: { completion_note: 'Seat already gone (no-op).' },
    });
    expect(summariseAuditRow(row)).toMatch(/completed with note/i);
    expect(summariseAuditRow(row)).toContain('Seat already gone (no-op).');
  });

  it('emits "(no field changes)" when before and after are deeply equal', () => {
    const row = makeAuditLog({
      action: 'update_seat',
      before: { scope: 'CO', type: 'auto' },
      after: { scope: 'CO', type: 'auto' },
    });
    expect(summariseAuditRow(row)).toBe('(no field changes)');
  });
});

describe('computeFieldDiff', () => {
  it('returns shape="empty" + zero rows when both sides are null', () => {
    const r = computeFieldDiff(null, null);
    expect(r.shape).toBe('empty');
    expect(r.rows).toHaveLength(0);
    expect(r.unchangedCount).toBe(0);
  });

  it('returns shape="create" with add rows when before is null', () => {
    const r = computeFieldDiff(null, { scope: 'CO', type: 'auto' });
    expect(r.shape).toBe('create');
    expect(r.rows.map((x) => x.field)).toEqual(['scope', 'type']);
    expect(r.rows.every((x) => x.kind === 'add')).toBe(true);
    expect(r.unchangedCount).toBe(0);
  });

  it('returns shape="delete" with remove rows when after is null', () => {
    const r = computeFieldDiff({ scope: 'CO', type: 'auto' }, null);
    expect(r.shape).toBe('delete');
    expect(r.rows.map((x) => x.field)).toEqual(['scope', 'type']);
    expect(r.rows.every((x) => x.kind === 'remove')).toBe(true);
  });

  it('returns shape="update" with only changed rows; counts unchanged separately', () => {
    const r = computeFieldDiff(
      { scope: 'CO', type: 'auto', member_email: 'alice@example.com' },
      { scope: 'CO', type: 'manual', member_email: 'alice@example.com' },
    );
    expect(r.shape).toBe('update');
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({
      field: 'type',
      kind: 'change',
      before: 'auto',
      after: 'manual',
    });
    expect(r.unchangedCount).toBe(2);
  });

  it('flattens manual_grants per scope (one row per scope-key)', () => {
    const r = computeFieldDiff(
      { manual_grants: { CO: ['alice@example.com'] } },
      { manual_grants: { CO: ['alice@example.com', 'bob@example.com'] } },
    );
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]?.field).toBe('manual_grants[CO]');
    expect(r.rows[0]?.kind).toBe('change');
  });

  it('flattens importer_callings per scope (added scope = add row)', () => {
    const r = computeFieldDiff(
      { importer_callings: { CO: ['Bishop'] } },
      { importer_callings: { CO: ['Bishop'], EN: ['Counselor'] } },
    );
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]?.field).toBe('importer_callings[EN]');
    expect(r.rows[0]?.kind).toBe('add');
  });

  it('strips canonical-email fields from update diffs', () => {
    const r = computeFieldDiff(
      { member_canonical: 'old@x.com', member_email: 'old@x.com', scope: 'CO' },
      { member_canonical: 'new@x.com', member_email: 'new@x.com', scope: 'EN' },
    );
    const fields = r.rows.map((x) => x.field).sort();
    // member_canonical filtered out; member_email + scope still present.
    expect(fields).toEqual(['member_email', 'scope']);
  });

  it('flattens manual_grants on create-shape rows (one row per scope)', () => {
    // Regression guard for the bug surfaced in the staging screenshot:
    // create_access rows skipped flattening because the create branch
    // only handled the top-level field, not the per-scope expansion.
    const after = {
      member_canonical: 'a@x.com',
      member_email: 'a@x.com',
      member_name: 'Alice',
      manual_grants: {
        CO: [
          {
            grant_id: 'g1',
            reason: 'Helper',
            granted_by: { email: 'mgr@x.com', canonical: 'mgr@x.com' },
            granted_at: { seconds: 1, nanoseconds: 0 },
          },
        ],
        stake: [
          {
            grant_id: 'g2',
            reason: 'Visitor',
            granted_by: { email: 'mgr@x.com', canonical: 'mgr@x.com' },
            granted_at: { seconds: 2, nanoseconds: 0 },
          },
        ],
      },
    };
    const r = computeFieldDiff(null, after);
    expect(r.shape).toBe('create');
    const fields = r.rows.map((x) => x.field).sort();
    // member_canonical stripped; manual_grants flattened to per-scope.
    expect(fields).toEqual([
      'manual_grants[CO]',
      'manual_grants[stake]',
      'member_email',
      'member_name',
    ]);
    expect(r.rows.every((row) => row.kind === 'add')).toBe(true);
  });

  it('flattens manual_grants on delete-shape rows (one row per scope)', () => {
    const before = {
      member_canonical: 'a@x.com',
      member_email: 'a@x.com',
      manual_grants: {
        CO: [
          {
            grant_id: 'g1',
            reason: 'Helper',
            granted_by: { email: 'mgr@x.com', canonical: 'mgr@x.com' },
            granted_at: { seconds: 1, nanoseconds: 0 },
          },
        ],
      },
    };
    const r = computeFieldDiff(before, null);
    expect(r.shape).toBe('delete');
    const fields = r.rows.map((x) => x.field).sort();
    expect(fields).toEqual(['manual_grants[CO]', 'member_email']);
    expect(r.rows.every((row) => row.kind === 'remove')).toBe(true);
  });

  it('strips canonical-email fields from create diffs', () => {
    const r = computeFieldDiff(null, {
      member_canonical: 'a@x.com',
      member_email: 'a@x.com',
      scope: 'CO',
    });
    const fields = r.rows.map((x) => x.field).sort();
    expect(fields).toEqual(['member_email', 'scope']);
  });

  it('flags a key present only in after as kind="add" inside an update', () => {
    const r = computeFieldDiff({ scope: 'CO' }, { scope: 'CO', new_field: 'x' });
    expect(r.shape).toBe('update');
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ field: 'new_field', kind: 'add' });
  });

  it('flags a key present only in before as kind="remove" inside an update', () => {
    const r = computeFieldDiff({ scope: 'CO', old_field: 'x' }, { scope: 'CO' });
    expect(r.shape).toBe('update');
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ field: 'old_field', kind: 'remove' });
  });

  it('treats null → "x" and "x" → null as changes (nullables)', () => {
    const r1 = computeFieldDiff({ note: null }, { note: 'something' });
    expect(r1.rows).toHaveLength(1);
    expect(r1.rows[0]).toMatchObject({ field: 'note', kind: 'change' });

    const r2 = computeFieldDiff({ note: 'something' }, { note: null });
    expect(r2.rows).toHaveLength(1);
    expect(r2.rows[0]).toMatchObject({ field: 'note', kind: 'change' });
  });

  it('handles cross-collection rows with disjoint key sets (manual_grants flattens)', () => {
    // A seats-shaped before paired with an access-shaped after — what
    // a member_canonical-filtered query can produce when paged across
    // collections. Every key on either side should appear; nested
    // manual_grants flattens to per-scope rows.
    const before = { member_email: 'alice@example.com', scope: 'CO', type: 'auto' };
    const after = { manual_grants: { CO: ['alice@example.com'] } };
    const r = computeFieldDiff(before, after);
    expect(r.shape).toBe('update');
    const fields = r.rows.map((x) => x.field).sort();
    expect(fields).toEqual(['manual_grants[CO]', 'member_email', 'scope', 'type']);
  });

  it('sorts diff rows alphabetically for stable rendering', () => {
    const r = computeFieldDiff(null, { z: 1, a: 2, m: 3 });
    expect(r.rows.map((x) => x.field)).toEqual(['a', 'm', 'z']);
  });
});

describe('formatDiffValue', () => {
  it('renders null and empty string as "(empty)"', () => {
    expect(formatDiffValue(null)).toBe('(empty)');
    expect(formatDiffValue('')).toBe('(empty)');
  });

  it('renders undefined (key absent on this side) as "(absent)"', () => {
    expect(formatDiffValue(undefined)).toBe('(absent)');
  });

  it('renders ISO timestamp strings in stake-local form (default tz)', () => {
    // No tz → default `America/Denver`. 12:34 UTC = 6:34 am MDT.
    expect(formatDiffValue('2026-04-28T12:34:56.789Z')).toBe('2026-04-28 6:34 am');
    expect(formatDiffValue('2026-04-28T12:34:56Z')).toBe('2026-04-28 6:34 am');
  });

  it('renders ISO timestamps in the supplied timezone', () => {
    expect(formatDiffValue('2026-04-28T12:34:56Z', 'UTC')).toBe('2026-04-28 12:34 pm');
  });

  it('renders Firestore Timestamps in stake-local form (default tz)', () => {
    const ts = Timestamp.fromDate(new Date('2026-04-28T12:34:56Z'));
    expect(formatDiffValue(ts)).toBe('2026-04-28 6:34 am');
  });

  it('renders serialised Firestore Timestamp envelopes', () => {
    // Audit-trigger payloads can land with the SDK reference encoder's
    // serialised form: `{ type, seconds, nanoseconds }`. The diff
    // renderer should still format these as readable timestamps.
    const envelope = {
      type: 'firestore/timestamp/1.0',
      seconds: Math.floor(Date.UTC(2026, 3, 28, 12, 34, 56) / 1000),
      nanoseconds: 0,
    };
    expect(formatDiffValue(envelope, 'UTC')).toBe('2026-04-28 12:34 pm');
  });

  it('renders primitive arrays as comma-separated', () => {
    expect(formatDiffValue(['a', 'b', 'c'])).toBe('a, b, c');
    expect(formatDiffValue([])).toBe('(empty list)');
  });

  it('renders ManualGrant arrays as readable per-grant summaries', () => {
    const grants = [
      {
        grant_id: 'g1',
        reason: 'Helper',
        granted_by: { email: 'tad.e.smith@gmail.com', canonical: 'tadesmith@gmail.com' },
        granted_at: { seconds: Math.floor(Date.UTC(2026, 3, 28, 12, 34) / 1000), nanoseconds: 0 },
      },
    ];
    const out = formatDiffValue(grants, 'UTC');
    expect(out).toContain('Helper');
    expect(out).toContain('by tad.e.smith@gmail.com');
    // Canonical email never leaks.
    expect(out).not.toContain('tadesmith@gmail.com');
    expect(out).toContain('2026-04-28 12:34 pm');
  });

  it('renders maps as readable key=value lists with canonical fields stripped', () => {
    expect(formatDiffValue({ CO: ['Bishop'] })).toBe('CO=Bishop');
    expect(formatDiffValue({ email: 'a@b.c', canonical: 'a@b.c' })).toBe('a@b.c'); // ActorRef shape collapses to the typed email.
  });

  it('renders empty maps as "(empty map)"', () => {
    expect(formatDiffValue({})).toBe('(empty map)');
  });

  it('truncates long primitives at 200 chars with an ellipsis', () => {
    const long = 'x'.repeat(250);
    const out = formatDiffValue(long);
    expect(out.endsWith('…')).toBe(true);
    expect(out.length).toBe(198); // 197 chars + ellipsis
  });
});

describe('bookkeeping field exclusion', () => {
  // Both consumers (diffKeys for the inline summary, computeFieldDiff
  // for the expanded table) should agree: lastActor / *_at / *_by
  // should never surface to the operator.
  const BOOKKEEPING_FIELD_NAMES = [
    'lastActor',
    'last_modified_at',
    'last_modified_by',
    'created_at',
    'created_by',
    'added_at',
    'added_by',
    'granted_at',
    'granted_by',
    'detected_at',
    'updated_at',
  ];

  it('diffKeys drops every bookkeeping field even when the value changed', () => {
    const before = Object.fromEntries(BOOKKEEPING_FIELD_NAMES.map((k) => [k, 'before']));
    const after = Object.fromEntries(BOOKKEEPING_FIELD_NAMES.map((k) => [k, 'after']));
    expect(diffKeys(before, after)).toEqual([]);
  });

  it('diffKeys keeps real fields alongside bookkeeping changes', () => {
    const before = { lastActor: { canonical: 'a' }, scope: 'CO', type: 'auto' };
    const after = { lastActor: { canonical: 'b' }, scope: 'CO', type: 'manual' };
    expect(diffKeys(before, after)).toEqual(['type']);
  });

  it('computeFieldDiff "create" shape drops bookkeeping fields', () => {
    const r = computeFieldDiff(null, {
      scope: 'CO',
      type: 'auto',
      lastActor: { canonical: 'a' },
      created_at: '2026-04-28T00:00:00Z',
      created_by: 'alice@example.com',
    });
    expect(r.shape).toBe('create');
    expect(r.rows.map((x) => x.field).sort()).toEqual(['scope', 'type']);
  });

  it('computeFieldDiff "delete" shape drops bookkeeping fields', () => {
    const r = computeFieldDiff(
      {
        scope: 'CO',
        type: 'auto',
        lastActor: { canonical: 'a' },
        added_at: '2026-04-28T00:00:00Z',
        added_by: 'alice@example.com',
      },
      null,
    );
    expect(r.shape).toBe('delete');
    expect(r.rows.map((x) => x.field).sort()).toEqual(['scope', 'type']);
  });

  it('computeFieldDiff "update" shape drops bookkeeping fields from both rows AND unchanged count', () => {
    // Bookkeeping fields aren't visible AND aren't counted in the
    // "N unchanged" trailer — surfacing "lastActor unchanged" would be
    // confusing because the operator never sees lastActor in the
    // first place.
    const r = computeFieldDiff(
      {
        scope: 'CO',
        type: 'auto',
        lastActor: { canonical: 'a' },
        last_modified_at: '2026-04-27',
        member_email: 'alice@example.com',
      },
      {
        scope: 'CO',
        type: 'manual',
        lastActor: { canonical: 'b' }, // changed but bookkeeping
        last_modified_at: '2026-04-28', // changed but bookkeeping
        member_email: 'alice@example.com',
      },
    );
    expect(r.shape).toBe('update');
    expect(r.rows.map((x) => x.field)).toEqual(['type']);
    // Two unchanged user fields (scope, member_email); bookkeeping
    // doesn't add to the count.
    expect(r.unchangedCount).toBe(2);
  });

  it('computeFieldDiff returns no rows when only bookkeeping changed', () => {
    const r = computeFieldDiff(
      { scope: 'CO', lastActor: { canonical: 'a' }, last_modified_at: '2026-04-27' },
      { scope: 'CO', lastActor: { canonical: 'b' }, last_modified_at: '2026-04-28' },
    );
    expect(r.shape).toBe('update');
    expect(r.rows).toEqual([]);
    expect(r.unchangedCount).toBe(1); // scope
  });
});

describe('auditActionCategory', () => {
  it('categorises CRUD actions as "crud"', () => {
    expect(auditActionCategory('create_seat')).toBe('crud');
    expect(auditActionCategory('update_seat')).toBe('crud');
    expect(auditActionCategory('delete_seat')).toBe('crud');
    expect(auditActionCategory('create_access')).toBe('crud');
    expect(auditActionCategory('update_access')).toBe('crud');
    expect(auditActionCategory('delete_access')).toBe('crud');
    expect(auditActionCategory('create_manager')).toBe('crud');
    expect(auditActionCategory('update_manager')).toBe('crud');
    expect(auditActionCategory('delete_manager')).toBe('crud');
    expect(auditActionCategory('update_stake')).toBe('crud');
  });

  it('categorises non-destructive request-lifecycle actions as "request"', () => {
    expect(auditActionCategory('submit_request')).toBe('request');
    expect(auditActionCategory('complete_request')).toBe('request');
    expect(auditActionCategory('cancel_request')).toBe('request');
    expect(auditActionCategory('create_request')).toBe('crud'); // CRUD wins on prefix
  });

  it('categorises reject_request as "system" (red) — destructive', () => {
    expect(auditActionCategory('reject_request')).toBe('system');
  });

  it('categorises importer actions as "import"', () => {
    expect(auditActionCategory('import_start')).toBe('import');
    expect(auditActionCategory('import_end')).toBe('import');
  });

  it('categorises system events as "system"', () => {
    expect(auditActionCategory('auto_expire')).toBe('system');
    expect(auditActionCategory('over_cap_warning')).toBe('system');
    expect(auditActionCategory('setup_complete')).toBe('system');
  });
});
