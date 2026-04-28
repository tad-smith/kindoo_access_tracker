// Phase-4 placeholder landing page. Renders the signed-in user's email
// and a pretty-printed dump of the decoded `Principal` shape. Lives
// inside the `_authed` group so it inherits the Shell + Nav layout.
//
// Deleted in Phase 5 once real role-based pages (Roster, Queue,
// Dashboard) ship and the default-landing rule resolves to one of
// them per the principal's role union.

import { createFileRoute } from '@tanstack/react-router';
import { usePrincipal, type Principal } from '../../lib/principal';

export const Route = createFileRoute('/_authed/hello')({
  component: Hello,
});

function Hello() {
  const principal = usePrincipal();

  return (
    <section style={{ maxWidth: '60ch', margin: '0 auto' }}>
      <h1>Hello, {principal.email || '(no email)'}</h1>
      <p>
        This is the Phase 4 placeholder landing page. Real role-based pages land starting in Phase
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
    </section>
  );
}

// Strip non-serializable function fields before pretty-printing.
function principalForDisplay(p: Principal) {
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
