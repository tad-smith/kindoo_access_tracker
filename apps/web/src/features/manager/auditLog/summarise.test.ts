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

  it('treats deep array changes as a change row', () => {
    const r = computeFieldDiff(
      { manual_grants: { CO: ['alice@example.com'] } },
      { manual_grants: { CO: ['alice@example.com', 'bob@example.com'] } },
    );
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]?.field).toBe('manual_grants');
  });

  it('treats nested map changes as a change row', () => {
    const r = computeFieldDiff(
      { importer_callings: { CO: ['Bishop'] } },
      { importer_callings: { CO: ['Bishop'], EN: ['Counselor'] } },
    );
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]?.field).toBe('importer_callings');
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

  it('handles cross-collection rows with disjoint key sets', () => {
    // A seats-shaped before paired with an access-shaped after — what
    // a member_canonical-filtered query can produce when paged across
    // collections. Every key on either side should appear.
    const before = { member_email: 'alice@example.com', scope: 'CO', type: 'auto' };
    const after = { manual_grants: { CO: ['alice@example.com'] } };
    const r = computeFieldDiff(before, after);
    expect(r.shape).toBe('update');
    const fields = r.rows.map((x) => x.field).sort();
    expect(fields).toEqual(['manual_grants', 'member_email', 'scope', 'type']);
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

  it('renders ISO timestamp strings in human-readable form', () => {
    expect(formatDiffValue('2026-04-28T12:34:56.789Z')).toBe('2026-04-28 12:34:56 UTC');
    expect(formatDiffValue('2026-04-28T12:34:56Z')).toBe('2026-04-28 12:34:56 UTC');
  });

  it('renders Firestore Timestamps in human-readable form', () => {
    const ts = Timestamp.fromDate(new Date('2026-04-28T12:34:56Z'));
    expect(formatDiffValue(ts)).toBe('2026-04-28 12:34:56 UTC');
  });

  it('renders primitive arrays as comma-separated', () => {
    expect(formatDiffValue(['a', 'b', 'c'])).toBe('a, b, c');
    expect(formatDiffValue([])).toBe('(empty list)');
  });

  it('renders nested arrays / maps as JSON', () => {
    expect(formatDiffValue({ CO: ['Bishop'] })).toBe('{"CO":["Bishop"]}');
    expect(formatDiffValue([{ a: 1 }])).toBe('[{"a":1}]');
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

  it('categorises request-lifecycle actions as "request"', () => {
    expect(auditActionCategory('submit_request')).toBe('request');
    expect(auditActionCategory('complete_request')).toBe('request');
    expect(auditActionCategory('reject_request')).toBe('request');
    expect(auditActionCategory('cancel_request')).toBe('request');
    expect(auditActionCategory('create_request')).toBe('crud'); // CRUD wins on prefix
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
