// Manager Requests Queue page (live). Pending-only; rendered as three
// ordered sections (Emergency / Outstanding / Future) using the
// `comparison_date` rule in `@kindoo/shared`'s `partitionPendingRequests`.
//
// The hands-on workflow lives in the Chrome extension: completing a
// request needs a signed-in Kindoo tab, and rejection is desktop-only.
// The one thing this page can do is ask the manager's OWN desktop
// extension to run an apply on their behalf — remote apply (D27), the
// `RemoteApply*` components below. When that desktop isn't online the
// page is exactly what it was before: read-only cards plus a note
// pointing at the extension.
//
// `focus` prop carries a request_id from a tapped push notification's
// deep-link (typed search param at the route level). On first render
// where it matches a request in the rendered list, the page scrolls
// the card into view, applies the `is-focused` class for ~2s, and
// strips the param from the URL so reload + back-forward stay clean.
// A `focus` value with no matching request (request was completed/
// cancelled before the user tapped) is silently dropped.

import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import {
  type AccessRequest,
  type Building,
  type KindooSite,
  type RemoteApplyDesktopWithId,
  type Ward,
  addBlockedByExistingSeat,
  deriveRequesterDisplay,
  existingSeatFacts,
  formatRequesterLabel,
  partitionPendingRequests,
  remoteApplyTargetSiteKey,
} from '@kindoo/shared';
import {
  useKindooSites,
  usePendingRequests,
  useQueueBuildings,
  useQueueStakeDoc,
  useQueueWards,
  useRemoteApplyJobsByRequest,
  useRemoteApplyPresence,
  type RemoteApplyJobsResult,
  type RemoteApplyJobWithId,
  type RemoteApplyPresenceResult,
} from './hooks';
import { RemoteApplyPresenceNote, RemoteApplyResults, RemoteApplyRow } from './RemoteApply';
import { homeSiteName, siteKeyLabel } from '../../../lib/kindooSites';
import {
  useAccessForMember,
  useKindooManagerForMember,
  useSeatForMember,
} from '../../requests/hooks';
import { useScopeLabel } from '../../../lib/scopeLabel';
import { Badge } from '../../../components/ui/Badge';
import { RosterMemberLine } from '../../../components/roster/RosterMemberLine';
import { CHROME_WEB_STORE_URL } from '../../../lib/links';
import { LoadingSpinner } from '../../../lib/render/LoadingSpinner';
import { EmptyState } from '../../../lib/render/EmptyState';

const FOCUS_HIGHLIGHT_MS = 2000;

export interface ManagerQueuePageProps {
  /**
   * Request id that arrived via the `?focus=<rid>` deep-link. When set
   * AND a matching request is in the rendered list, the card scrolls
   * into view + flashes the `is-focused` highlight, then the param is
   * stripped from the URL.
   */
  focus?: string;
}

export function ManagerQueuePage({ focus }: ManagerQueuePageProps = {}) {
  const pending = usePendingRequests();
  const navigate = useNavigate();
  const labelForScope = useScopeLabel();
  // Remote apply: presence + the manager's job mailbox. Resolved once
  // here and passed down rather than called per card — one listener
  // each, not one per pending request. The three catalogues are what a
  // request's target Kindoo site is derived from (scope → ward →
  // building) and named with.
  const remoteApply = useRemoteApplyPresence();
  const remoteApplyJobs = useRemoteApplyJobsByRequest();
  const kindooSites = useKindooSites();
  const queueWards = useQueueWards();
  const queueBuildings = useQueueBuildings();
  const stakeDoc = useQueueStakeDoc();
  const sites = kindooSites.data ?? [];
  const wards = queueWards.data ?? [];
  const buildings = queueBuildings.data ?? [];
  const homeName = homeSiteName(stakeDoc.data);
  // A ward missing from the catalogue derives to home, which is the
  // right answer for genuinely-unknown wards and the wrong one for
  // "the subscription hasn't arrived yet". Withhold the button until
  // both catalogues have landed rather than let that window queue a
  // home job for a foreign-site request.
  const siteCatalogueReady = !queueWards.isLoading && !queueBuildings.isLoading;
  // The covered sites, named — every one of them. With two tabs live,
  // naming one would read as a promise about the other. A foreign site
  // missing from the catalogue falls back to the name its own tab
  // reported, which is at least the string Kindoo shows.
  const coveredSiteNames = remoteApply.desktops
    .map((d) => siteKeyLabel(d.site_key, sites, homeName) ?? d.kindoo_site_name)
    .filter((name): name is string => !!name)
    .sort((a, b) => a.localeCompare(b));

  // Compute "now" once per render. Time advancement during a session
  // shifts the Outstanding/Future boundary by at most a tick — well
  // below the day-level resolution the section cutoff cares about.
  const sections = useMemo(
    () => partitionPendingRequests(pending.data ?? [], new Date()),
    [pending.data],
  );

  // Currently-highlighted card id. Driven by the `focus` effect below;
  // applied as the `is-focused` class to the matching card so the CSS
  // animation runs. Cleared after FOCUS_HIGHLIGHT_MS.
  const [focusedId, setFocusedId] = useState<string | undefined>(undefined);

  // First-render-with-this-focus effect. Re-fires when `focus` changes
  // (consecutive notifications targeting different request ids). When
  // the matching card is in the rendered list:
  //   1. Scroll into view (smooth, centred). The DOM lookup happens in
  //      a microtask via `queueMicrotask` so React has committed the
  //      cards before we read.
  //   2. Set focusedId so the matching card picks up `is-focused`.
  //   3. Schedule a timeout to clear focusedId so the highlight fades.
  //   4. Strip `?focus=` from the URL via `replace` navigation so
  //      reload + back-forward do not re-trigger.
  // A focus value with no matching request silently does nothing —
  // the request was likely completed/cancelled before the user tapped.
  useEffect(() => {
    if (!focus) return;
    if (!pending.data) return;
    const exists = pending.data.some((r) => r.request_id === focus);
    if (!exists) {
      // Still strip the param so a stale deep-link does not linger.
      navigate({
        to: '/manager/queue',
        search: (prev: Record<string, unknown>) => ({ ...prev, focus: undefined }),
        replace: true,
      }).catch(() => {});
      return;
    }
    setFocusedId(focus);
    queueMicrotask(() => {
      const el = document.querySelector(`[data-testid="queue-card-${focus}"]`);
      if (el && 'scrollIntoView' in el) {
        (el as HTMLElement).scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    });
    const timer = window.setTimeout(() => {
      setFocusedId((current) => (current === focus ? undefined : current));
    }, FOCUS_HIGHLIGHT_MS);
    navigate({
      to: '/manager/queue',
      search: (prev: Record<string, unknown>) => ({ ...prev, focus: undefined }),
      replace: true,
    }).catch(() => {});
    return () => {
      window.clearTimeout(timer);
    };
  }, [focus, pending.data, navigate]);

  // The acknowledgement for a finished remote apply, mounted once for
  // the page and rendered in both branches below — including the loading
  // one. Its whole point is that it does not depend on the pending list:
  // a successful apply marks its request complete, so by the time there
  // is an outcome to show, the request is out of `pending` and its card
  // is gone. It used to live inside that card, and the manager saw the
  // dialog for the few milliseconds between the two snapshots landing.
  const results = (
    <RemoteApplyResults jobs={remoteApplyJobs.resolved} labelForScope={labelForScope} />
  );

  if (pending.isLoading || pending.data === undefined) {
    return (
      <section className="kd-page-medium">
        <h1>Request Queue</h1>
        <LoadingSpinner />
        {results}
      </section>
    );
  }

  const total = pending.data.length;

  return (
    <section className="kd-page-medium">
      <h1>Request Queue</h1>
      <ExtensionNote />
      <RemoteApplyPresenceNote presence={remoteApply} siteNames={coveredSiteNames} />
      {results}

      {total === 0 ? (
        <EmptyState message="No pending requests. Nice." />
      ) : (
        <div data-testid="queue-cards">
          <QueueSection
            title="Emergency Requests"
            testid="queue-section-urgent"
            requests={sections.urgent}
            focusedId={focusedId}
            labelForScope={labelForScope}
            remoteApply={remoteApply}
            remoteApplyJobs={remoteApplyJobs}
            kindooSites={sites}
            wards={wards}
            buildings={buildings}
            homeSiteName={homeName}
            siteCatalogueReady={siteCatalogueReady}
          />
          <QueueSection
            title="Outstanding Requests"
            testid="queue-section-outstanding"
            requests={sections.outstanding}
            focusedId={focusedId}
            labelForScope={labelForScope}
            remoteApply={remoteApply}
            remoteApplyJobs={remoteApplyJobs}
            kindooSites={sites}
            wards={wards}
            buildings={buildings}
            homeSiteName={homeName}
            siteCatalogueReady={siteCatalogueReady}
          />
          <QueueSection
            title="Future Requests"
            testid="queue-section-future"
            requests={sections.future}
            focusedId={focusedId}
            labelForScope={labelForScope}
            remoteApply={remoteApply}
            remoteApplyJobs={remoteApplyJobs}
            kindooSites={sites}
            wards={wards}
            buildings={buildings}
            homeSiteName={homeName}
            siteCatalogueReady={siteCatalogueReady}
          />
        </div>
      )}
    </section>
  );
}

// Muted note pointing managers at the Chrome extension. Completing by
// hand and rejecting still live there; remote apply (below the note) is
// the one thing that can be started from this page. Deliberately vague
// about *which* requests — that is per Kindoo site now, and the presence
// line directly underneath answers it precisely.
function ExtensionNote() {
  return (
    <p className="kd-queue-readonly-note font-bold" data-testid="queue-extension-note" role="note">
      Requests are completed and rejected in the Chrome extension on your computer. With Kindoo open
      there, you can apply them from here.{' '}
      <a
        href={CHROME_WEB_STORE_URL}
        target="_blank"
        rel="noopener noreferrer"
        data-testid="queue-extension-note-link"
      >
        Install the extension
      </a>
    </p>
  );
}

interface QueueSectionProps {
  title: string;
  testid: string;
  requests: readonly AccessRequest[];
  focusedId: string | undefined;
  labelForScope: (scope: string) => string;
  remoteApply: RemoteApplyPresenceResult;
  remoteApplyJobs: RemoteApplyJobsResult;
  kindooSites: readonly KindooSite[];
  wards: readonly Ward[];
  buildings: readonly Building[];
  homeSiteName: string | null;
  siteCatalogueReady: boolean;
}

function QueueSection({
  title,
  testid,
  requests,
  focusedId,
  labelForScope,
  remoteApply,
  remoteApplyJobs,
  kindooSites,
  wards,
  buildings,
  homeSiteName,
  siteCatalogueReady,
}: QueueSectionProps) {
  // Hide the entire section (header + body) when empty — the operator
  // brief is unambiguous on this.
  if (requests.length === 0) return null;
  return (
    <div className="kd-queue-section" data-testid={testid}>
      <h2 className="kd-queue-section-header">
        {title} ({requests.length})
      </h2>
      <div className="kd-queue-cards">
        {requests.map((request) => {
          // Derived, not read off the request: `AccessRequest`'s own
          // `kindoo_site_id` is the site of the grant a `remove` targets,
          // not the site the request provisions on. The derivation lives
          // in `@kindoo/shared` because it must give the same answer as
          // the extension's `checkRequestSite`, which is what actually
          // refuses a provision on the wrong site.
          const targetSiteKey = siteCatalogueReady
            ? remoteApplyTargetSiteKey(request, wards, buildings)
            : null;
          return (
            <QueueCard
              key={request.request_id}
              request={request}
              isFocused={focusedId === request.request_id}
              labelForScope={labelForScope}
              remoteApplyTargetSiteKey={targetSiteKey}
              remoteApplyDesktop={remoteApply.desktopForSite(targetSiteKey)}
              remoteApplyAnyLive={remoteApply.state === 'live'}
              remoteApplySiteName={
                targetSiteKey ? siteKeyLabel(targetSiteKey, kindooSites, homeSiteName) : null
              }
              remoteApplyJob={remoteApplyJobs.byRequest.get(request.request_id)}
              remoteApplyJobsLoading={remoteApplyJobs.isLoading}
            />
          );
        })}
      </div>
    </div>
  );
}

interface QueueCardProps {
  request: AccessRequest;
  isFocused: boolean;
  labelForScope: (scope: string) => string;
  /** Site key this request provisions on; null until the catalogues land. */
  remoteApplyTargetSiteKey: string | null;
  /** The live tab that can apply THIS request's site, or null. */
  remoteApplyDesktop: RemoteApplyDesktopWithId | null;
  /** Any tab live in this stake — gates the per-card "open <site>" line. */
  remoteApplyAnyLive: boolean;
  /** Name of the site this request needs, when it resolves. */
  remoteApplySiteName: string | null;
  remoteApplyJob: RemoteApplyJobWithId | undefined;
  remoteApplyJobsLoading: boolean;
}

function QueueCard({
  request,
  isFocused,
  labelForScope,
  remoteApplyTargetSiteKey,
  remoteApplyDesktop,
  remoteApplyAnyLive,
  remoteApplySiteName,
  remoteApplyJob,
  remoteApplyJobsLoading,
}: QueueCardProps) {
  // Live duplicate check: surface inside the queue card so the manager
  // sees, at a glance, that an add request collides with an existing
  // seat, and withhold remote apply for it.
  //
  // The predicate is `@kindoo/shared`'s, not a local copy, because the
  // extension card gates its own Provision & Complete button on the
  // same question — and a broader gate here does NOT fail safe. It
  // hides Apply and prints "reject it" for a stake-scope `add_manual`
  // onto a seat with no stake grant, which is precisely the shape the
  // web's own "Give Access To Stake Buildings" button produces and
  // which `planAddMerge` provisions cleanly. See the module for the
  // full rule.
  const dup = useSeatForMember(request.member_canonical);
  const blockedByDuplicate = addBlockedByExistingSeat(request, existingSeatFacts(dup.data));

  // Informational edit-side analog of the duplicate-add chip: an
  // `edit_*` completion modifies the member's existing seat, so a
  // missing seat means the request targets something that no longer
  // exists. Gate on `isSuccess` (subscription resolved) — NOT just
  // `!dup.data`, which is also true while the seat is still loading.
  // The DIY `useFirestoreDoc` keeps `status === 'success'` for a
  // resolved-but-absent doc (data stays `undefined`), so
  // `isSuccess && !dup.data` is the unambiguous "resolved, no seat"
  // signal and never flashes during load.
  const isEditType =
    request.type === 'edit_auto' || request.type === 'edit_manual' || request.type === 'edit_temp';
  const editTargetMissing = isEditType && dup.isSuccess && !dup.data;

  // Live-derive the requester's name + calling from their access doc for
  // this request's scope (Option A — nothing is captured on the request).
  // While a doc is still loading or absent, its `data` is undefined;
  // `deriveRequesterDisplay(undefined, …, undefined)` yields all nulls, so
  // `formatRequesterLabel` falls back to the email (no empty flash).
  //
  // Kindoo Managers may submit in any scope without an access row, so
  // their `kindooManagers` doc backstops both fields — `{Name} (Kindoo
  // Manager)`. The access doc wins on each field independently.
  const requesterAccess = useAccessForMember(request.requester_canonical);
  const requesterManager = useKindooManagerForMember(request.requester_canonical);
  const requesterLabel = formatRequesterLabel(
    deriveRequesterDisplay(requesterAccess.data, request.scope, requesterManager.data),
    request.requester_email,
  );

  const reqDate = (() => {
    const ts = request.requested_at as unknown as { toDate?: () => Date };
    if (ts && ts.toDate) return ts.toDate().toISOString().slice(0, 16).replace('T', ' ');
    return '';
  })();

  const isUrgent = request.urgent === true;
  const className = [
    'kd-queue-card',
    isUrgent ? 'kd-card-urgent' : '',
    isFocused ? 'is-focused' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <div
      className={className}
      data-testid={`queue-card-${request.request_id}`}
      data-request-type={request.type}
      data-urgent={isUrgent ? 'true' : 'false'}
    >
      <div className="kd-queue-card-line1 kd-queue-card-meta-row">
        <span className="kd-queue-card-badges">
          <Badge variant={badgeVariantForType(request.type)}>{labelForType(request.type)}</Badge>
          <span className="roster-card-chip roster-card-scope">{labelForScope(request.scope)}</span>
        </span>
        {reqDate ? (
          <span className="kd-queue-card-meta kd-queue-card-submitted">
            <strong>Submitted:</strong> {reqDate}
          </span>
        ) : null}
      </div>
      <div className="kd-queue-card-meta">
        <span>
          <strong>{request.type === 'remove' ? 'Remove Access For:' : 'Give Access To:'}</strong>{' '}
          <span className="roster-card-member">
            <RosterMemberLine name={request.member_name} email={request.member_email} />
          </span>
        </span>
      </div>
      {request.reason ? (
        <div className="kd-queue-card-meta">
          <span>
            <strong>{request.type === 'remove' ? 'Removal reason:' : 'Calling:'}</strong>{' '}
            {request.reason}
          </span>
        </div>
      ) : null}
      {(request.type === 'add_temp' || request.type === 'edit_temp') &&
      (request.start_date || request.end_date) ? (
        <div className="kd-queue-card-meta">
          <span>
            <strong>Dates:</strong> {request.start_date ?? '?'} → {request.end_date ?? '?'}
          </span>
        </div>
      ) : null}
      {request.building_names.length > 0 ? (
        <div className="kd-queue-card-meta" data-testid={`queue-buildings-${request.request_id}`}>
          <span>
            <strong>
              {request.type === 'edit_auto' ||
              request.type === 'edit_manual' ||
              request.type === 'edit_temp'
                ? '→ Buildings:'
                : 'Buildings:'}
            </strong>{' '}
            {request.building_names.join(', ')}
          </span>
        </div>
      ) : null}
      {request.comment ? (
        <div className="kd-queue-card-meta">
          <span>
            <strong>Comment:</strong> {request.comment}
          </span>
        </div>
      ) : null}
      <div className="kd-queue-card-meta">
        <span>
          <strong>Requester:</strong> {requesterLabel}
        </span>
      </div>
      {blockedByDuplicate && dup.data ? (
        <div
          className="kd-queue-card-error"
          role="alert"
          data-testid={`queue-duplicate-error-${request.request_id}`}
        >
          <Badge variant="danger">Error</Badge> Member already has a {dup.data.type} seat in{' '}
          {labelForScope(dup.data.scope)}. This request can&apos;t be completed — reject it.
        </div>
      ) : null}
      {editTargetMissing ? (
        <div
          className="kd-queue-card-error"
          role="alert"
          data-testid={`queue-edit-missing-seat-${request.request_id}`}
        >
          <Badge variant="danger">Error</Badge> This request edits a seat that no longer exists.
        </div>
      ) : null}
      {/* Remote apply. Suppressed on the two cards that already say
          "this can't be completed" — offering to run a provision that
          is known to fail would be worse than offering nothing. */}
      {blockedByDuplicate || editTargetMissing ? null : (
        <RemoteApplyRow
          requestId={request.request_id}
          targetSiteKey={remoteApplyTargetSiteKey}
          desktop={remoteApplyDesktop}
          anyDesktopLive={remoteApplyAnyLive}
          requestSiteName={remoteApplySiteName}
          job={remoteApplyJob}
          jobsLoading={remoteApplyJobsLoading}
        />
      )}
    </div>
  );
}

function labelForType(t: AccessRequest['type']): string {
  switch (t) {
    case 'add_manual':
      return 'Add (manual)';
    case 'add_temp':
      return 'Add (temp)';
    case 'remove':
      return 'Remove';
    case 'edit_auto':
      return 'Edit (auto)';
    case 'edit_manual':
      return 'Edit (manual)';
    case 'edit_temp':
      return 'Edit (temp)';
  }
}

// Badge palette per request type. Edit types share the `info` variant
// so they read as a distinct "Edit" family at a glance against the
// add/remove badges; the type label (Edit (auto) / (manual) / (temp))
// still disambiguates within that family.
function badgeVariantForType(t: AccessRequest['type']) {
  switch (t) {
    case 'add_manual':
      return 'manual' as const;
    case 'add_temp':
      return 'temp' as const;
    case 'remove':
      return 'danger' as const;
    case 'edit_auto':
    case 'edit_manual':
    case 'edit_temp':
      return 'info' as const;
  }
}
