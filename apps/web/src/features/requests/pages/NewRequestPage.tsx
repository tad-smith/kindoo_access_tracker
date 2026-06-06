// Single "New Request" page — one entry point for every role
// permitted to submit. The scope dropdown is filtered strictly by the
// roles the user holds in this stake; manager / superadmin status
// alone does not grant ward-scope creation rights (see `scopeOptions.ts`
// for the full rule table — the B-3 bug fix).
//
//   - Stake-claim member: 'stake'.
//   - Bishopric (per-ward): that ward.
//   - Stake + bishopric: 'stake' plus those wards (no others).
//   - No stake / no bishopric: empty scope list → form renders the
//     not-authorized message.
//
// The form body is role-agnostic; it auto-collapses to a "Requesting
// for: <scope>" line when only one scope is offered, and renders a
// dropdown otherwise. See `NewRequestForm`.
//
// Mounts at `/new`. The legacy `/bishopric/new` and `/stake/new`
// paths route here via TanStack-Router redirects so external links
// keep working. `?scope=` (forwarded as `initialScope`) pre-selects the
// scope dropdown when it matches one of the principal's allowed scopes.
//
// The form data (scopes / buildings / wards) comes from the shared
// `useNewRequestFormData` hook — the same hook the roster-header
// `NewRequestDialog` consumes, so page and dialog can't diverge.

import { LoadingSpinner } from '../../../lib/render/LoadingSpinner';
import { NewRequestForm } from '../components/NewRequestForm';
import { useNewRequestFormData } from '../hooks';

export interface NewRequestPageProps {
  /** Pre-selected scope from `?scope=...`. Applied by the form only if
   *  it matches one of the principal's allowed scopes. */
  initialScope?: string;
}

export function NewRequestPage({ initialScope }: NewRequestPageProps = {}) {
  const { scopes, buildings, wards, isLoading } = useNewRequestFormData();

  return (
    <section className="kd-page-narrow">
      <h1>New Request</h1>
      <p className="kd-page-subtitle">Submit a manual or temporary access request.</p>
      {isLoading ? (
        <LoadingSpinner />
      ) : (
        <NewRequestForm
          scopes={scopes}
          buildings={buildings}
          wards={wards}
          {...(initialScope !== undefined ? { initialScope } : {})}
        />
      )}
    </section>
  );
}
