// Unit tests for the pure setup-gate decision helper. The route gates
// in `routes/_authed.tsx` and `routes/index.tsx` both delegate here,
// so this test file is the regression net for the staging-bug repro
// reported on 2026-04-29 (manager-claimed user during
// `setup_complete=false` was being routed to Dashboard instead of
// SetupInProgress).

import { describe, expect, it } from 'vitest';
import { gateDecision, type GatePrincipal, type GateStakeRead } from './setupGate';
import type { Stake } from '@kindoo/shared';

function principal(over: Partial<GatePrincipal> = {}): GatePrincipal {
  return {
    firebaseAuthSignedIn: true,
    isAuthenticated: false,
    email: 'random@example.com',
    canonical: 'random@example.com',
    ...over,
  };
}

function stakeLoaded(over: Partial<Stake> = {}): GateStakeRead {
  return {
    status: 'success',
    data: {
      stake_id: 'csnorth',
      stake_name: 'Test Stake',
      bootstrap_admin_email: 'admin@example.com',
      setup_complete: false,
      ...over,
    },
  };
}

const stakePending: GateStakeRead = { status: 'pending', data: undefined };
const stakeAbsent: GateStakeRead = { status: 'success', data: undefined };

describe('gateDecision', () => {
  it('returns sign-in when no Firebase Auth user is signed in', () => {
    const p = principal({ firebaseAuthSignedIn: false });
    expect(gateDecision(p, stakeLoaded({ setup_complete: true }))).toBe('sign-in');
    expect(gateDecision(p, stakeAbsent)).toBe('sign-in');
    expect(gateDecision(p, stakePending)).toBe('sign-in');
  });

  it('returns pending when the stake-doc subscription has not yet resolved', () => {
    const p = principal({ isAuthenticated: true });
    expect(gateDecision(p, stakePending)).toBe('pending');
  });

  it('returns wizard for the bootstrap admin during setup_complete=false', () => {
    const p = principal({
      email: 'admin@example.com',
      canonical: 'admin@example.com',
    });
    const decision = gateDecision(
      p,
      stakeLoaded({ setup_complete: false, bootstrap_admin_email: 'admin@example.com' }),
    );
    expect(decision).toBe('wizard');
  });

  it('returns setup-in-progress for non-admin no-claims user during setup_complete=false', () => {
    const p = principal({
      email: 'random@example.com',
      canonical: 'random@example.com',
    });
    expect(gateDecision(p, stakeLoaded({ setup_complete: false }))).toBe('setup-in-progress');
  });

  it('regression: returns setup-in-progress for MANAGER-CLAIMED user during setup_complete=false', () => {
    // The staging repro from 2026-04-29: a user with manager claims
    // signing in against a stake doc with setup_complete=false MUST
    // see SetupInProgress, not their role-default Dashboard. The
    // setup-complete gate takes precedence over claims-based routing.
    const p = principal({
      isAuthenticated: true,
      email: 'tad.e.smith@gmail.com',
      canonical: 'tadesmith@gmail.com',
    });
    expect(gateDecision(p, stakeLoaded({ setup_complete: false }))).toBe('setup-in-progress');
  });

  it('regression: returns setup-in-progress when bootstrap_admin_email is missing', () => {
    // The exact staging repro: setup_complete=false AND the
    // bootstrap_admin_email field is absent. Previous gate computed
    // adminCanonical='' which short-circuited the wizard branch
    // correctly, but tests didn't pin this case.
    const p = principal({
      isAuthenticated: true,
      email: 'tad.e.smith@gmail.com',
      canonical: 'tadesmith@gmail.com',
    });
    const stake: GateStakeRead = {
      status: 'success',
      data: { setup_complete: false, stake_name: 'Test Stake' },
    };
    expect(gateDecision(p, stake)).toBe('setup-in-progress');
  });

  it('absent stake doc is treated as setup_complete=false (Option A)', () => {
    // The operator MUST seed the stake doc per the runbook; an absent
    // doc is "not yet set up", never "fully set up". A claim-bearing
    // user must see SetupInProgress, not their role-default landing.
    const p = principal({
      isAuthenticated: true,
      email: 'mgr@example.com',
      canonical: 'mgr@example.com',
    });
    expect(gateDecision(p, stakeAbsent)).toBe('setup-in-progress');
  });

  it('returns authed for claim-bearing principal when setup_complete=true', () => {
    const p = principal({
      isAuthenticated: true,
      email: 'mgr@example.com',
      canonical: 'mgr@example.com',
    });
    expect(gateDecision(p, stakeLoaded({ setup_complete: true }))).toBe('authed');
  });

  it('returns not-authorized for no-claims user when setup_complete=true', () => {
    const p = principal({
      isAuthenticated: false,
      email: 'random@example.com',
      canonical: 'random@example.com',
    });
    expect(gateDecision(p, stakeLoaded({ setup_complete: true }))).toBe('not-authorized');
  });

  it('regression: setup_complete with non-boolean truthy value still routes via setup-incomplete', () => {
    // Strict-truthy polarity: only the boolean `true` counts. A typo
    // that wrote the string `"true"` or the number `1` must not
    // accidentally let users past the gate.
    const p = principal({
      isAuthenticated: true,
      email: 'mgr@example.com',
      canonical: 'mgr@example.com',
    });
    const stake: GateStakeRead = {
      status: 'success',
      // Cast through unknown so TS lets us simulate a malformed doc.
      data: { setup_complete: 'true' as unknown as boolean, stake_name: 'Test' },
    };
    expect(gateDecision(p, stake)).toBe('setup-in-progress');
  });

  it('returns not-authorized when the stake-doc listener errors', () => {
    // Most common cause: post-setup no-claims user hitting a
    // setup_complete=true stake. The rules require isAnyMember; the
    // listener errors with permission-denied once the snapshot would
    // have landed. We surface NotAuthorized rather than SetupInProgress
    // — the user genuinely lacks access.
    const p = principal({ isAuthenticated: false, email: 'noclaims@example.com' });
    const stake: GateStakeRead = { status: 'error', data: undefined };
    expect(gateDecision(p, stake)).toBe('not-authorized');
  });

  it('canonicalises bootstrap_admin_email and current email before comparison', () => {
    // The wizard match must canonicalise both sides so a Gmail user's
    // typed-form `Tad.E.Smith+test@gmail.com` matches a stored
    // `tadesmith@gmail.com`.
    const p = principal({
      isAuthenticated: false,
      email: 'Tad.E.Smith+test@gmail.com',
      canonical: 'tadesmith@gmail.com',
    });
    const decision = gateDecision(
      p,
      stakeLoaded({
        setup_complete: false,
        bootstrap_admin_email: 'Tad.E.Smith@googlemail.com',
      }),
    );
    expect(decision).toBe('wizard');
  });
});
