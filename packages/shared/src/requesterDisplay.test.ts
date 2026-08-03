import { describe, expect, it } from 'vitest';
import { deriveRequesterDisplay, formatRequesterLabel } from './requesterDisplay.js';
import type { Access } from './types/access.js';
import type { KindooManager } from './types/kindooManager.js';
import type { TimestampLike } from './types/userIndex.js';

const ts = (): TimestampLike => ({
  seconds: 0,
  nanoseconds: 0,
  toDate: () => new Date(0),
  toMillis: () => 0,
});

// Minimal Access factory — only the fields the deriver reads. The
// bookkeeping fields (timestamps, actors) are irrelevant here, so the
// cast keeps the fixtures focused.
function access(partial: Partial<Access>): Access {
  return {
    member_canonical: 'requester@example.com',
    member_email: 'requester@example.com',
    member_name: '',
    importer_callings: {},
    manual_grants: {},
    ...partial,
  } as Access;
}

// Minimal KindooManager factory — only `name` + `active` are read.
function manager(partial: Partial<KindooManager> = {}): KindooManager {
  return {
    member_canonical: 'requester@example.com',
    member_email: 'requester@example.com',
    name: 'Manager Mary',
    active: true,
    ...partial,
  } as KindooManager;
}

describe('deriveRequesterDisplay', () => {
  it('returns the name and the scope calling', () => {
    const doc = access({ member_name: 'Bishop Bob', importer_callings: { CO: ['Bishop'] } });
    expect(deriveRequesterDisplay(doc, 'CO')).toEqual({ name: 'Bishop Bob', calling: 'Bishop' });
  });

  it('joins multiple callings for the scope with ", "', () => {
    const doc = access({
      member_name: 'Sister Ann',
      importer_callings: { CO: ['Relief Society President', 'Ward Clerk'] },
    });
    expect(deriveRequesterDisplay(doc, 'CO')).toEqual({
      name: 'Sister Ann',
      calling: 'Relief Society President, Ward Clerk',
    });
  });

  it('ignores callings for other scopes', () => {
    const doc = access({ member_name: 'Bishop Bob', importer_callings: { MR: ['Bishop'] } });
    expect(deriveRequesterDisplay(doc, 'CO')).toEqual({ name: 'Bishop Bob', calling: null });
  });

  it('falls back to manual-grant reasons when no importer calling for the scope', () => {
    const doc = access({
      member_name: 'Brother Lee',
      importer_callings: {},
      manual_grants: {
        stake: [
          {
            grant_id: 'g1',
            reason: 'Stake technology specialist',
            granted_by: { email: 'm@x.com', canonical: 'm@x.com' },
            granted_at: ts(),
          },
        ],
      },
    });
    expect(deriveRequesterDisplay(doc, 'stake')).toEqual({
      name: 'Brother Lee',
      calling: 'Stake technology specialist',
    });
  });

  it('prefers importer callings over manual-grant reasons for the same scope', () => {
    const doc = access({
      member_name: 'Bishop Bob',
      importer_callings: { CO: ['Bishop'] },
      manual_grants: {
        CO: [
          {
            grant_id: 'g1',
            reason: 'Manual reason that should be ignored',
            granted_by: { email: 'm@x.com', canonical: 'm@x.com' },
            granted_at: ts(),
          },
        ],
      },
    });
    expect(deriveRequesterDisplay(doc, 'CO')).toEqual({ name: 'Bishop Bob', calling: 'Bishop' });
  });

  it('returns a name with a null calling when no calling or grant applies', () => {
    const doc = access({ member_name: 'Nameless Calling', importer_callings: {} });
    expect(deriveRequesterDisplay(doc, 'CO')).toEqual({ name: 'Nameless Calling', calling: null });
  });

  it('trims the name and drops empty / whitespace callings', () => {
    const doc = access({
      member_name: '  Bishop Bob  ',
      importer_callings: { CO: ['  ', 'Bishop', ''] },
    });
    expect(deriveRequesterDisplay(doc, 'CO')).toEqual({ name: 'Bishop Bob', calling: 'Bishop' });
  });

  it('treats a whitespace-only name as null', () => {
    const doc = access({ member_name: '   ', importer_callings: { CO: ['Bishop'] } });
    expect(deriveRequesterDisplay(doc, 'CO')).toEqual({ name: null, calling: 'Bishop' });
  });

  it('returns all nulls for a null / undefined access doc', () => {
    expect(deriveRequesterDisplay(null, 'CO')).toEqual({ name: null, calling: null });
    expect(deriveRequesterDisplay(undefined, 'CO')).toEqual({ name: null, calling: null });
  });
});

// Kindoo Managers may submit in any scope without an `access` row. The
// optional third argument backstops name and calling independently.
describe('deriveRequesterDisplay — manager fallback', () => {
  it('uses the manager doc for both name and calling when there is no access doc', () => {
    const display = deriveRequesterDisplay(null, 'CO', manager({ name: 'Manager Mary' }));
    expect(display).toEqual({ name: 'Manager Mary', calling: 'Kindoo Manager' });
    expect(formatRequesterLabel(display, 'mary@x.com')).toBe('Manager Mary (Kindoo Manager)');
  });

  it('keeps the access name but falls back to "Kindoo Manager" when no calling applies', () => {
    const doc = access({ member_name: 'Bishop Bob', importer_callings: { MR: ['Bishop'] } });
    const display = deriveRequesterDisplay(doc, 'CO', manager({ name: 'Manager Mary' }));
    // Access wins on name; the manager only supplies the missing calling.
    expect(display).toEqual({ name: 'Bishop Bob', calling: 'Kindoo Manager' });
    expect(formatRequesterLabel(display, 'bob@x.com')).toBe('Bishop Bob (Kindoo Manager)');
  });

  it('prefers a real calling from the access doc over "Kindoo Manager"', () => {
    const doc = access({ member_name: 'Bishop Bob', importer_callings: { CO: ['Bishop'] } });
    expect(deriveRequesterDisplay(doc, 'CO', manager())).toEqual({
      name: 'Bishop Bob',
      calling: 'Bishop',
    });
  });

  it('prefers a manual-grant reason from the access doc over "Kindoo Manager"', () => {
    const doc = access({
      member_name: 'Brother Lee',
      manual_grants: {
        stake: [
          {
            grant_id: 'g1',
            reason: 'Stake technology specialist',
            granted_by: { email: 'm@x.com', canonical: 'm@x.com' },
            granted_at: ts(),
          },
        ],
      },
    });
    expect(deriveRequesterDisplay(doc, 'stake', manager())).toEqual({
      name: 'Brother Lee',
      calling: 'Stake technology specialist',
    });
  });

  it('trims the manager name and ignores a whitespace-only one', () => {
    expect(deriveRequesterDisplay(null, 'CO', manager({ name: '  Manager Mary  ' })).name).toBe(
      'Manager Mary',
    );
    expect(deriveRequesterDisplay(null, 'CO', manager({ name: '   ' }))).toEqual({
      name: null,
      // An active manager still supplies the calling even with no usable name.
      calling: 'Kindoo Manager',
    });
  });

  it('ignores an inactive manager doc entirely', () => {
    expect(deriveRequesterDisplay(null, 'CO', manager({ active: false }))).toEqual({
      name: null,
      calling: null,
    });
    const doc = access({ member_name: 'Bishop Bob' });
    expect(deriveRequesterDisplay(doc, 'CO', manager({ active: false }))).toEqual({
      name: 'Bishop Bob',
      calling: null,
    });
  });

  it('ignores a null / undefined manager doc', () => {
    expect(deriveRequesterDisplay(null, 'CO', null)).toEqual({ name: null, calling: null });
    expect(deriveRequesterDisplay(null, 'CO', undefined)).toEqual({ name: null, calling: null });
  });

  // Backward compatibility: every two-arg call must produce exactly what
  // it produced before the third parameter existed.
  it('leaves two-argument calls unchanged', () => {
    expect(deriveRequesterDisplay(null, 'CO')).toEqual({ name: null, calling: null });
    const withCalling = access({
      member_name: 'Bishop Bob',
      importer_callings: { CO: ['Bishop'] },
    });
    expect(deriveRequesterDisplay(withCalling, 'CO')).toEqual({
      name: 'Bishop Bob',
      calling: 'Bishop',
    });
    const noCalling = access({ member_name: 'Bishop Bob' });
    expect(deriveRequesterDisplay(noCalling, 'CO')).toEqual({ name: 'Bishop Bob', calling: null });
  });
});

describe('formatRequesterLabel', () => {
  it('renders "Name (Calling)" when both are known', () => {
    expect(formatRequesterLabel({ name: 'Bishop Bob', calling: 'Bishop' }, 'bob@x.com')).toBe(
      'Bishop Bob (Bishop)',
    );
  });

  it('renders the name alone when there is no calling', () => {
    expect(formatRequesterLabel({ name: 'Bishop Bob', calling: null }, 'bob@x.com')).toBe(
      'Bishop Bob',
    );
  });

  it('falls back to the email when no name is known', () => {
    expect(formatRequesterLabel({ name: null, calling: null }, 'bob@x.com')).toBe('bob@x.com');
    // Even a stray calling cannot render without a name.
    expect(formatRequesterLabel({ name: null, calling: 'Bishop' }, 'bob@x.com')).toBe('bob@x.com');
  });
});
