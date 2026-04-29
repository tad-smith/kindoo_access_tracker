// Top-level React error boundary. Wraps the entire app in `main.tsx`
// so an unrecoverable render error never leaves the user staring at a
// blank page.
//
// Why a class component when the rest of the codebase is functional:
// React 19 still has no hook equivalent for `componentDidCatch` /
// `getDerivedStateFromError`. This is the one sanctioned exception to
// the "functional components only" rule in `apps/web/CLAUDE.md`.
//
// The Firestore JS SDK 12.x can throw `INTERNAL ASSERTION FAILED:
// Unexpected state (ID: ca9 / b815)` from inside its own microtask
// dispatch when a target receives `permission-denied` on an initial
// subscribe under specific listener-registry race conditions (see
// `apps/web/src/lib/setupGate.ts` header for the chain we know about).
// The DIY hooks in `lib/data/` already convert listener errors to a
// hook error state (see `useFirestoreDoc.ts` defensive layer notes),
// but the SDK panic propagates from outside our callback path. This
// boundary is the last line of defense.
//
// The fallback is intentionally minimal — title, copy, two buttons
// (Reload, Sign out). No styled chrome (we may have failed mid-style-
// load), no router/Firestore reads (those may be the failure source).
//
// `componentDidCatch` logs the failure with a stable prefix so the
// operator can search the staging console for `[RootErrorBoundary]`.

import { Component, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class RootErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: { componentStack?: string | null }): void {
    // Stable prefix so the operator can grep the staging console. The
    // SDK panic surfaces with a recognisable `INTERNAL ASSERTION FAILED`
    // / `Unexpected state` substring; logging error.message verbatim
    // lets us distinguish it from app-level render bugs.
    // eslint-disable-next-line no-console
    console.error('[RootErrorBoundary] caught render error', {
      message: error.message,
      name: error.name,
      stack: error.stack,
      componentStack: info.componentStack ?? null,
    });
  }

  reload = (): void => {
    // Force a fresh load. `location.reload()` blows away the in-memory
    // SDK state that caused the panic; the next mount starts clean.
    window.location.reload();
  };

  signOutAndReload = (): void => {
    // Clearing IndexedDB drops Firestore's local persistence + the
    // Auth state. We avoid reaching into the SDK directly here because
    // its module may itself be the failure source; deleting the per-
    // origin databases is independent of any in-memory state. The
    // operator shouldn't have to clear browser data manually.
    Promise.all([
      indexedDB.deleteDatabase('firebaseLocalStorageDb'),
      indexedDB.deleteDatabase('firestore/[DEFAULT]/main'),
    ])
      .catch(() => {
        // Best-effort; the reload still happens.
      })
      .finally(() => {
        window.location.reload();
      });
  };

  override render(): ReactNode {
    if (this.state.error === null) {
      return this.props.children;
    }

    // Inline styles only — Tailwind / global CSS may be the failure
    // source, and the boundary must render even when the rest of the
    // style pipeline is broken.
    const containerStyle: React.CSSProperties = {
      minHeight: '100vh',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '1rem',
      gap: '1rem',
      textAlign: 'center',
      fontFamily: 'system-ui, sans-serif',
    };
    const buttonStyle: React.CSSProperties = {
      padding: '0.5rem 1rem',
      borderRadius: '0.25rem',
      border: '1px solid #888',
      background: '#fff',
      cursor: 'pointer',
    };

    return (
      <main style={containerStyle} data-testid="root-error-boundary">
        <h1 style={{ margin: 0 }}>Something went wrong.</h1>
        <p style={{ maxWidth: '50ch', margin: 0 }}>
          The app hit an unexpected error and can&rsquo;t continue. Try reloading the page. If the
          problem keeps happening, sign out below to clear local state.
        </p>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button type="button" style={buttonStyle} onClick={this.reload}>
            Reload
          </button>
          <button type="button" style={buttonStyle} onClick={this.signOutAndReload}>
            Sign out and reload
          </button>
        </div>
      </main>
    );
  }
}
