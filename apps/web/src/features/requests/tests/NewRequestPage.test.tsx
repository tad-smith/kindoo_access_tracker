// Component tests for the consolidated NewRequestPage. The scope
// derivation itself is unit-tested in `scopeOptions.test.ts`; this
// suite verifies the page wires the helper correctly, gates on the
// buildings catalogue load, and renders the unified shell.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Principal } from '../../../lib/principal';
import type { Building, Ward } from '@kindoo/shared';
import type { ScopeOption } from '../components/NewRequestForm';

const mockedPrincipal: { current: Principal } = {
  current: emptyPrincipal(),
};

const wardsState: { current: { data: Ward[] | undefined; isLoading: boolean } } = {
  current: { data: [], isLoading: false },
};

const buildingsState: { current: { data: Building[] | undefined; isLoading: boolean } } = {
  current: { data: [], isLoading: false },
};

vi.mock('../../../lib/principal', () => ({
  usePrincipal: () => mockedPrincipal.current,
}));

vi.mock('../../../lib/data', () => ({
  useFirestoreCollection: (q: unknown) => {
    if ((q as { kind?: string }).kind === 'wards') return wardsState.current;
    return buildingsState.current;
  },
}));

vi.mock('../../../lib/firebase', () => ({ db: {} }));

vi.mock('../../../lib/docs', () => ({
  buildingsCol: () => ({ kind: 'buildings' }),
  wardsCol: () => ({ kind: 'wards' }),
}));

// Render the form as a deterministic stub so we can assert on the
// scope list passed in.
vi.mock('../components/NewRequestForm', () => ({
  NewRequestForm: ({ scopes }: { scopes: ScopeOption[] }) => (
    <div data-testid="form-stub">
      {scopes.length === 0 ? (
        <p>NO_SCOPES</p>
      ) : (
        <ul data-testid="scopes">
          {scopes.map((s) => (
            <li key={s.value}>
              {s.value}::{s.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  ),
}));

vi.mock('../../../lib/render/LoadingSpinner', () => ({
  LoadingSpinner: () => <div data-testid="spinner" />,
}));

import { NewRequestPage } from '../pages/NewRequestPage';

function emptyPrincipal(): Principal {
  return {
    isAuthenticated: true,
    firebaseAuthSignedIn: true,
    email: 'a@b.c',
    canonical: 'a@b.c',
    isPlatformSuperadmin: false,
    managerStakes: [],
    stakeMemberStakes: [],
    bishopricWards: {},
    hasAnyRole: () => false,
    wardsInStake: () => [],
  };
}

function setPrincipal(overrides: Partial<Principal>): void {
  mockedPrincipal.current = { ...emptyPrincipal(), ...overrides };
}

beforeEach(() => {
  setPrincipal({});
  wardsState.current = { data: [], isLoading: false };
  buildingsState.current = { data: [], isLoading: false };
});

function readScopes(): string[] {
  if (screen.queryByText('NO_SCOPES')) return [];
  return Array.from(screen.getByTestId('scopes').querySelectorAll('li')).map(
    (li) => li.textContent ?? '',
  );
}

describe('NewRequestPage — wires the role-filtered scope list (B-3)', () => {
  it('stake-only: renders just the stake option in the dropdown', () => {
    setPrincipal({ stakeMemberStakes: ['csnorth'] });
    render(<NewRequestPage />);
    expect(readScopes()).toEqual(['stake::Stake']);
  });

  it('bishopric-only: renders only the user wards, sorted', () => {
    setPrincipal({ bishopricWards: { csnorth: ['CO', 'BA'] } });
    render(<NewRequestPage />);
    expect(readScopes()).toEqual(['BA::Ward BA', 'CO::Ward CO']);
  });

  it('stake + bishopric: renders stake plus the user wards (no other wards)', () => {
    setPrincipal({
      stakeMemberStakes: ['csnorth'],
      bishopricWards: { csnorth: ['CO'] },
    });
    render(<NewRequestPage />);
    expect(readScopes()).toEqual(['stake::Stake', 'CO::Ward CO']);
  });

  it('manager-only (no stake / no ward): renders the not-authorized message — empty scope list', () => {
    setPrincipal({ managerStakes: ['csnorth'] });
    render(<NewRequestPage />);
    expect(readScopes()).toEqual([]);
  });

  it('platform superadmin without explicit stake / ward claim: empty scope list', () => {
    setPrincipal({ isPlatformSuperadmin: true });
    render(<NewRequestPage />);
    expect(readScopes()).toEqual([]);
  });

  it('shows the spinner while the buildings catalogue is loading', () => {
    setPrincipal({ stakeMemberStakes: ['csnorth'] });
    buildingsState.current = { data: undefined, isLoading: true };
    render(<NewRequestPage />);
    expect(screen.getByTestId('spinner')).toBeInTheDocument();
    expect(screen.queryByTestId('form-stub')).toBeNull();
  });

  it('mounts the form once buildings have landed even if wards are still loading (form falls back to []).', () => {
    setPrincipal({ bishopricWards: { csnorth: ['CO'] } });
    wardsState.current = { data: undefined, isLoading: true };
    buildingsState.current = { data: [], isLoading: false };
    render(<NewRequestPage />);
    expect(screen.getByTestId('form-stub')).toBeInTheDocument();
  });

  it('renders the unified heading "New Request"', () => {
    setPrincipal({ stakeMemberStakes: ['csnorth'] });
    render(<NewRequestPage />);
    expect(screen.getByRole('heading', { name: 'New Request' })).toBeInTheDocument();
  });

  it('wraps the page in the narrow-width container (600px max)', () => {
    setPrincipal({ stakeMemberStakes: ['csnorth'] });
    const { container } = render(<NewRequestPage />);
    expect(container.querySelector('section.kd-page-narrow')).not.toBeNull();
  });
});
