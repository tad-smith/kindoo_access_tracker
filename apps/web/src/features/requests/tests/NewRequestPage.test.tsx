// Unit tests for the consolidated NewRequestPage. Verifies the
// principal-to-scope-list derivation under each role permutation:
// manager / stake / bishopric / mixed / no-role. The form body itself
// is mocked to render the scope list as plain text so the assertion
// is straight equality on the dropdown options.

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
    // Discriminate by the docs-helper return shape; both return mocked
    // objects with `kind` markers below.
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

function setWards(codes: string[]): void {
  const stamp = {
    seconds: 0,
    nanoseconds: 0,
    toDate: () => new Date(),
    toMillis: () => 0,
  };
  wardsState.current = {
    data: codes.map(
      (ward_code) =>
        ({
          ward_code,
          ward_name: `Ward ${ward_code}`,
          building_ids: [],
          created_at: stamp,
          last_modified_at: stamp,
          lastActor: { email: 'a@b.c', canonical: 'a@b.c' },
        }) as unknown as Ward,
    ),
    isLoading: false,
  };
}

beforeEach(() => {
  setPrincipal({});
  setWards([]);
  buildingsState.current = { data: [], isLoading: false };
});

function readScopes(): string[] {
  if (screen.queryByText('NO_SCOPES')) return [];
  return Array.from(screen.getByTestId('scopes').querySelectorAll('li')).map(
    (li) => li.textContent ?? '',
  );
}

describe('NewRequestPage — scope derivation by role', () => {
  it('manager-only: stake + every configured ward', () => {
    setPrincipal({ managerStakes: ['csnorth'] });
    setWards(['CO', 'BA', 'GR']);
    render(<NewRequestPage />);
    expect(readScopes()).toEqual(['stake::Stake', 'BA::Ward BA', 'CO::Ward CO', 'GR::Ward GR']);
  });

  it('stake-only: stake scope only', () => {
    setPrincipal({ stakeMemberStakes: ['csnorth'] });
    setWards(['CO', 'BA']);
    render(<NewRequestPage />);
    expect(readScopes()).toEqual(['stake::Stake']);
  });

  it('bishopric-only: each claimed ward, sorted', () => {
    setPrincipal({ bishopricWards: { csnorth: ['CO', 'BA'] } });
    setWards(['CO', 'BA', 'GR']);
    render(<NewRequestPage />);
    expect(readScopes()).toEqual(['BA::Ward BA', 'CO::Ward CO']);
  });

  it('manager + bishopric: every ward (manager subsumes bishopric restriction)', () => {
    setPrincipal({
      managerStakes: ['csnorth'],
      bishopricWards: { csnorth: ['CO'] },
    });
    setWards(['CO', 'BA']);
    render(<NewRequestPage />);
    expect(readScopes()).toEqual(['stake::Stake', 'BA::Ward BA', 'CO::Ward CO']);
  });

  it('stake + bishopric: stake plus the bishopric wards (deduplicated)', () => {
    setPrincipal({
      stakeMemberStakes: ['csnorth'],
      bishopricWards: { csnorth: ['CO', 'BA'] },
    });
    setWards(['CO', 'BA', 'GR']);
    render(<NewRequestPage />);
    expect(readScopes()).toEqual(['stake::Stake', 'BA::Ward BA', 'CO::Ward CO']);
  });

  it('platform superadmin without explicit manager: stake + every ward', () => {
    setPrincipal({ isPlatformSuperadmin: true });
    setWards(['BA', 'CO']);
    render(<NewRequestPage />);
    expect(readScopes()).toEqual(['stake::Stake', 'BA::Ward BA', 'CO::Ward CO']);
  });

  it('no role: empty scope list (form renders the not-authorized message)', () => {
    setPrincipal({});
    render(<NewRequestPage />);
    expect(readScopes()).toEqual([]);
  });

  it('manager: shows the spinner while the wards catalogue is loading', () => {
    setPrincipal({ managerStakes: ['csnorth'] });
    wardsState.current = { data: undefined, isLoading: true };
    render(<NewRequestPage />);
    expect(screen.getByTestId('spinner')).toBeInTheDocument();
    expect(screen.queryByTestId('form-stub')).toBeNull();
  });

  it('non-manager: skips the wards-loading spinner (claims-derived scope list is enough)', () => {
    setPrincipal({ bishopricWards: { csnorth: ['CO'] } });
    wardsState.current = { data: undefined, isLoading: true };
    render(<NewRequestPage />);
    // Spinner is for wards-loading on managers; bishopric-only paths
    // use claims, so the form mounts straight away.
    expect(screen.getByTestId('form-stub')).toBeInTheDocument();
  });

  it('renders the unified heading "New Request"', () => {
    setPrincipal({ managerStakes: ['csnorth'] });
    setWards([]);
    render(<NewRequestPage />);
    expect(screen.getByRole('heading', { name: 'New Request' })).toBeInTheDocument();
  });

  it('wraps the page in the narrow-width container (600px max)', () => {
    setPrincipal({ managerStakes: ['csnorth'] });
    setWards([]);
    const { container } = render(<NewRequestPage />);
    expect(container.querySelector('section.kd-page-narrow')).not.toBeNull();
  });
});
