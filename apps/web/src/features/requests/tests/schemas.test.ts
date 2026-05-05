// Schema-level tests. The form-level tests assert the rendered
// behaviour; here we lock the underlying zod schemas so a refactor
// can't silently weaken validation.

import { describe, expect, it } from 'vitest';
import type { Ward } from '@kindoo/shared';
import {
  completeAddRequestSchema,
  makeNewRequestSchema,
  newRequestSchema,
  rejectRequestSchema,
  removeRequestSchema,
} from '../schemas';

describe('newRequestSchema', () => {
  it('accepts a valid add_manual ward-scope submission', () => {
    const result = newRequestSchema.safeParse({
      type: 'add_manual',
      scope: 'CO',
      member_email: 'bob@example.com',
      member_name: 'Bob',
      reason: 'sub teacher',
      comment: '',
      start_date: '',
      end_date: '',
      building_names: [],
      urgent: false,
    });
    expect(result.success).toBe(true);
  });

  it('rejects an empty member_name on add types', () => {
    const result = newRequestSchema.safeParse({
      type: 'add_manual',
      scope: 'CO',
      member_email: 'bob@example.com',
      member_name: '',
      reason: 'r',
      comment: '',
      start_date: '',
      end_date: '',
      building_names: [],
      urgent: false,
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty buildings on a stake-scope submission', () => {
    const result = newRequestSchema.safeParse({
      type: 'add_manual',
      scope: 'stake',
      member_email: 'bob@example.com',
      member_name: 'Bob',
      reason: 'r',
      comment: '',
      start_date: '',
      end_date: '',
      building_names: [],
      urgent: false,
    });
    expect(result.success).toBe(false);
  });

  it('accepts add_temp with valid date range', () => {
    const result = newRequestSchema.safeParse({
      type: 'add_temp',
      scope: 'CO',
      member_email: 'bob@example.com',
      member_name: 'Bob',
      reason: 'r',
      comment: '',
      start_date: '2026-05-01',
      end_date: '2026-05-08',
      building_names: [],
      urgent: false,
    });
    expect(result.success).toBe(true);
  });

  it('rejects add_temp with end before start', () => {
    const result = newRequestSchema.safeParse({
      type: 'add_temp',
      scope: 'CO',
      member_email: 'bob@example.com',
      member_name: 'Bob',
      reason: 'r',
      comment: '',
      start_date: '2026-05-10',
      end_date: '2026-05-01',
      building_names: [],
      urgent: false,
    });
    expect(result.success).toBe(false);
  });

  it('rejects add_temp with malformed start_date', () => {
    const result = newRequestSchema.safeParse({
      type: 'add_temp',
      scope: 'CO',
      member_email: 'bob@example.com',
      member_name: 'Bob',
      reason: 'r',
      comment: '',
      start_date: '2026-5-1',
      end_date: '2026-05-08',
      building_names: [],
      urgent: false,
    });
    expect(result.success).toBe(false);
  });

  it('accepts urgent=true when comment is non-empty', () => {
    const result = newRequestSchema.safeParse({
      type: 'add_manual',
      scope: 'CO',
      member_email: 'bob@example.com',
      member_name: 'Bob',
      reason: 'r',
      comment: 'why this is urgent',
      start_date: '',
      end_date: '',
      building_names: [],
      urgent: true,
    });
    expect(result.success).toBe(true);
  });

  it('rejects urgent=true with empty comment', () => {
    const result = newRequestSchema.safeParse({
      type: 'add_manual',
      scope: 'CO',
      member_email: 'bob@example.com',
      member_name: 'Bob',
      reason: 'r',
      comment: '',
      start_date: '',
      end_date: '',
      building_names: [],
      urgent: true,
    });
    expect(result.success).toBe(false);
  });

  it('rejects urgent=true with whitespace-only comment', () => {
    const result = newRequestSchema.safeParse({
      type: 'add_manual',
      scope: 'CO',
      member_email: 'bob@example.com',
      member_name: 'Bob',
      reason: 'r',
      comment: '   ',
      start_date: '',
      end_date: '',
      building_names: [],
      urgent: true,
    });
    expect(result.success).toBe(false);
  });
});

describe('makeNewRequestSchema(wards) — cross-ward comment-required gate', () => {
  // The factory layers the "ward + non-default building → comment
  // required" gate on top of the base schema. Every other rule is
  // covered by the `newRequestSchema` block above; here we lock the
  // new gate's truth table.

  const stamp = { seconds: 0, nanoseconds: 0, toDate: () => new Date(), toMillis: () => 0 };
  const wards: Ward[] = [
    {
      ward_code: 'CO',
      ward_name: 'Cordera',
      building_name: 'Cordera Building',
      seat_cap: 20,
      created_at: stamp,
      last_modified_at: stamp,
      lastActor: { email: 'a@b.c', canonical: 'a@b.c' },
    } as unknown as Ward,
    {
      ward_code: 'GE',
      ward_name: 'Genoa',
      building_name: 'Genoa Building',
      seat_cap: 20,
      created_at: stamp,
      last_modified_at: stamp,
      lastActor: { email: 'a@b.c', canonical: 'a@b.c' },
    } as unknown as Ward,
  ];
  const schema = makeNewRequestSchema(wards);

  function base() {
    return {
      type: 'add_manual' as const,
      scope: 'CO',
      member_email: 'bob@example.com',
      member_name: 'Bob',
      reason: 'sub teacher',
      comment: '',
      start_date: '',
      end_date: '',
      building_names: ['Cordera Building'],
      urgent: false,
    };
  }

  it('admits a ward submission whose buildings are all in the ward default set with empty comment', () => {
    const result = schema.safeParse(base());
    expect(result.success).toBe(true);
  });

  it('rejects a ward submission carrying a non-default building with empty comment', () => {
    const result = schema.safeParse({
      ...base(),
      building_names: ['Cordera Building', 'Genoa Building'],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a ward submission carrying ONLY a non-default building with empty comment', () => {
    const result = schema.safeParse({
      ...base(),
      building_names: ['Genoa Building'],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a ward submission with whitespace-only comment when the selection is cross-ward', () => {
    const result = schema.safeParse({
      ...base(),
      building_names: ['Cordera Building', 'Genoa Building'],
      comment: '   ',
    });
    expect(result.success).toBe(false);
  });

  it('admits a ward submission with a non-default building and a non-empty comment', () => {
    const result = schema.safeParse({
      ...base(),
      building_names: ['Cordera Building', 'Genoa Building'],
      comment: 'Helping a member from the next ward over.',
    });
    expect(result.success).toBe(true);
  });

  it('does not gate stake-scope submissions on a comment regardless of building selection', () => {
    const result = schema.safeParse({
      ...base(),
      scope: 'stake',
      building_names: ['Cordera Building', 'Genoa Building'],
      comment: '',
    });
    expect(result.success).toBe(true);
  });

  it('keeps urgent=true requiring a comment even for the in-ward selection (precedence with the urgent rule)', () => {
    const result = schema.safeParse({
      ...base(),
      urgent: true,
    });
    expect(result.success).toBe(false);
  });
});

describe('removeRequestSchema', () => {
  it('rejects an empty reason', () => {
    expect(removeRequestSchema.safeParse({ reason: '' }).success).toBe(false);
    expect(removeRequestSchema.safeParse({ reason: '   ' }).success).toBe(false);
  });
  it('accepts a non-empty reason', () => {
    expect(removeRequestSchema.safeParse({ reason: 'no longer needs' }).success).toBe(true);
  });
});

describe('rejectRequestSchema', () => {
  it('rejects an empty reason', () => {
    expect(rejectRequestSchema.safeParse({ rejection_reason: '' }).success).toBe(false);
  });
  it('accepts a non-empty reason', () => {
    expect(rejectRequestSchema.safeParse({ rejection_reason: 'duplicate' }).success).toBe(true);
  });
});

describe('completeAddRequestSchema', () => {
  it('rejects an empty buildings list', () => {
    expect(completeAddRequestSchema.safeParse({ building_names: [] }).success).toBe(false);
  });
  it('accepts ≥1 building', () => {
    expect(
      completeAddRequestSchema.safeParse({ building_names: ['Cordera Building'] }).success,
    ).toBe(true);
  });
});
