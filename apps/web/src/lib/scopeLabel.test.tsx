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

// The pure `scopeLabel` is re-exported here from `@kindoo/shared`; its
// behaviour is unit-tested there. This file covers the web-only
// `useScopeLabel` hook that wires it to the live wards subscription.
import { useScopeLabel } from './scopeLabel';

const wards = [
  makeWard({ ward_code: 'CO', ward_name: 'Maple' }),
  makeWard({ ward_code: 'MR', ward_name: 'Meadow Run' }),
];

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
