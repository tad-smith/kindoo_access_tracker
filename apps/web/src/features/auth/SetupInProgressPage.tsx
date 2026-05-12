// Shown to any signed-in user who is NOT the bootstrap admin while
// `stakes/{stakeId}.setup_complete` is still `false`. Deliberately
// distinct from `NotAuthorized`: the user isn't unauthorised, the app
// isn't ready yet.
//
// No sign-out button. Refreshing won't help, and telling the user to
// sign out is misleading — their sign-in is fine, they just can't do
// anything until the bootstrap admin finishes setup.
//
// Once `stake.setup_complete` flips to `true`, the routing gate skips
// this page and the user's next page load lands on the normal
// role-resolution path.

import { useFirestoreDoc } from '../../lib/data';
import { stakeRef } from '../../lib/docs';
import { db } from '../../lib/firebase';
import { STAKE_ID } from '../../lib/constants';
import { usePrincipal } from '../../lib/principal';

export function SetupInProgressPage() {
  const principal = usePrincipal();
  const stake = useFirestoreDoc(stakeRef(db, STAKE_ID));
  const adminEmail = stake.data?.bootstrap_admin_email;

  return (
    <main
      style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '1rem',
        gap: '1rem',
        textAlign: 'center',
      }}
    >
      <h1>Setup in progress</h1>
      <p style={{ maxWidth: '50ch' }}>
        Stake Building Access for this stake is still being configured.
        {principal.email ? (
          <>
            {' '}
            You&rsquo;re signed in as <code>{principal.email}</code>, but there&rsquo;s nothing to
            do here yet.
          </>
        ) : null}
      </p>
      <p style={{ maxWidth: '50ch' }}>
        {adminEmail ? (
          <>
            Check back later, or contact your administrator (<code>{adminEmail}</code>).
          </>
        ) : (
          <>Check back later, or contact your administrator.</>
        )}
      </p>
    </main>
  );
}
