// Unit tests for the pure resolvers in `features/organizations/hooks`:
// `organizationName` (id → name, with the "No Organization" fallbacks)
// and `sortOrganizations` (case-insensitive alpha, non-mutating).

import { describe, expect, it } from 'vitest';
import type { Organization } from '@kindoo/shared';
import { NO_ORGANIZATION_LABEL, organizationName, sortOrganizations } from '../hooks';

const TS = { seconds: 0, nanoseconds: 0 } as unknown as Organization['created_at'];

function makeOrg(overrides: Partial<Organization>): Organization {
  return {
    organization_id: 'org-1',
    name: 'Org One',
    seat_cap: 10,
    created_at: TS,
    last_modified_at: TS,
    lastActor: { email: 'a@b.com', canonical: 'a@b.com' },
    ...overrides,
  };
}

describe('organizationName', () => {
  const orgs = [
    makeOrg({ organization_id: 'youth-conference', name: 'Youth Conference' }),
    makeOrg({ organization_id: 'primary-childrens', name: "Primary Children's" }),
  ];

  it('resolves a known id to its name', () => {
    expect(organizationName(orgs, 'youth-conference')).toBe('Youth Conference');
  });

  it('returns "No Organization" for a null id', () => {
    expect(organizationName(orgs, null)).toBe(NO_ORGANIZATION_LABEL);
  });

  it('returns "No Organization" for an undefined / absent id', () => {
    expect(organizationName(orgs, undefined)).toBe(NO_ORGANIZATION_LABEL);
  });

  it('falls back to "No Organization" when the id does not resolve', () => {
    expect(organizationName(orgs, 'deleted-org')).toBe(NO_ORGANIZATION_LABEL);
  });

  it('falls back to "No Organization" when the catalogue is undefined (still loading)', () => {
    expect(organizationName(undefined, 'youth-conference')).toBe(NO_ORGANIZATION_LABEL);
  });
});

describe('sortOrganizations', () => {
  it('sorts alphabetically, case-insensitive', () => {
    const orgs = [
      makeOrg({ organization_id: 'b', name: 'banner' }),
      makeOrg({ organization_id: 'a', name: 'Apple' }),
      makeOrg({ organization_id: 'c', name: 'Cherry' }),
    ];
    expect(sortOrganizations(orgs).map((o) => o.name)).toEqual(['Apple', 'banner', 'Cherry']);
  });

  it('does not mutate the input array', () => {
    const orgs = [makeOrg({ name: 'Zeta' }), makeOrg({ name: 'Alpha' })];
    const before = orgs.map((o) => o.name);
    sortOrganizations(orgs);
    expect(orgs.map((o) => o.name)).toEqual(before);
  });

  it('returns an empty array for an undefined catalogue', () => {
    expect(sortOrganizations(undefined)).toEqual([]);
  });
});
