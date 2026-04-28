// Phase 2 placeholder landing page.
//
// Renders the signed-in user's email + a pretty-printed dump of the
// decoded `Principal` object (custom claims via `usePrincipal()`). This
// is the "Hello page renders email + decoded roles" proof from the
// migration plan Phase 2 sub-tasks.
//
// Replaced in Phase 5/6 by real role-based pages (Roster, Queue, etc.).
// The migration plan explicitly calls this out: "Phase-2-only
// `pages/hello.ts` shows email + roles. Deleted in Phase 6."

import { usePrincipal } from '../lib/principal';

export function Hello() {
  const principal = usePrincipal();

  return (
    <main style={{ padding: '1rem', maxWidth: '60ch', margin: '0 auto' }}>
      <h1>Hello, {principal.email || '(no email)'}</h1>
      <p>
        This is the Phase 2 placeholder landing page. Real role-based pages land starting in Phase
        5.
      </p>
      <h2>Decoded principal</h2>
      <pre
        style={{
          background: '#f4f4f4',
          padding: '0.75rem',
          borderRadius: '4px',
          overflowX: 'auto',
        }}
      >
        {JSON.stringify(principalForDisplay(principal), null, 2)}
      </pre>
    </main>
  );
}

// Strip non-serializable function fields before pretty-printing.
function principalForDisplay(p: ReturnType<typeof usePrincipal>) {
  return {
    isAuthenticated: p.isAuthenticated,
    email: p.email,
    canonical: p.canonical,
    isPlatformSuperadmin: p.isPlatformSuperadmin,
    managerStakes: p.managerStakes,
    stakeMemberStakes: p.stakeMemberStakes,
    bishopricWards: p.bishopricWards,
  };
}
