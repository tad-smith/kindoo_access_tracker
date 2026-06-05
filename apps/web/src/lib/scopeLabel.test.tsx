import { describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { makeWard } from '../../test/fixtures';

const activeStakeMock = vi.fn();
const useFirestoreCollectionMock = vi.fn();

vi.mock('./useActiveStake', () => ({
  useActiveStake: () => activeStakeMock(),
}));

vi.mock('./data', () => ({
  useFirestoreCollection: () => useFirestoreCollectionMock(),
}));

vi.mock('./firebase', () => ({ db: {} }));
vi.mock('./docs', () => ({ wardsCol: () => ({ kind: 'wards' }) }));

import { scopeLabel, useScopeLabel } from './scopeLabel';

const wards = [
  makeWard({ ward_code: 'CO', ward_name: 'Maple' }),
  makeWard({ ward_code: 'MR', ward_name: 'Meadow Run' }),
];

describe('scopeLabel', () => {
  it('labels the stake scope as "Stake"', () => {
    expect(scopeLabel('stake', wards)).toBe('Stake');
  });

  it('resolves a ward code to its ward_name', () => {
    expect(scopeLabel('CO', wards)).toBe('Maple');
    expect(scopeLabel('MR', wards)).toBe('Meadow Run');
  });

  it('falls back to the raw code when the ward is not in the catalogue', () => {
    expect(scopeLabel('ZZ', wards)).toBe('ZZ');
  });

  it('falls back to the raw code when the wards list is empty (not yet hydrated)', () => {
    expect(scopeLabel('CO', [])).toBe('CO');
  });
});

describe('useScopeLabel', () => {
  it('returns a resolver backed by the live wards subscription', () => {
    activeStakeMock.mockReturnValue('csnorth');
    useFirestoreCollectionMock.mockReturnValue({ data: wards });
    const { result } = renderHook(() => useScopeLabel());
    expect(result.current('stake')).toBe('Stake');
    expect(result.current('CO')).toBe('Maple');
    expect(result.current('ZZ')).toBe('ZZ');
  });

  it('falls back to the raw code while the wards subscription is unresolved', () => {
    activeStakeMock.mockReturnValue('csnorth');
    useFirestoreCollectionMock.mockReturnValue({ data: undefined });
    const { result } = renderHook(() => useScopeLabel());
    expect(result.current('CO')).toBe('CO');
    expect(result.current('stake')).toBe('Stake');
  });
});
