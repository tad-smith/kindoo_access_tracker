// Sync drift report panel. Phase 1 was read-only; Phase 2 adds per-row
// Fix buttons that dispatch through `content/kindoo/sync/fix.ts`.
//
// State machine: idle → loading → report | error.
//
// On "Run Sync" the panel fires reads in parallel:
//   - getSyncData() (SW → Firestore) — all SBA collections needed for drift.
//   - listAllEnvironmentUsers() (CS → Kindoo) — every Kindoo env-user, paginated.
//   - buildRuleDoorMap() (CS → Kindoo) — one call per AccessRule to
//     learn each rule's door set. Used downstream to derive each
//     user's effective building access from their per-door grants
//     (covers BOTH AccessSchedules-derived AND Church Access
//     Automation direct grants).
//
// After the bulk listing returns, the panel walks the users with a
// small concurrency cap, calling `getUserDoorIds` per user, and stamps
// `derivedBuildings` onto each one. Progress text updates as users
// complete. With ~313 users + concurrency=4 and ~100-200ms per Kindoo
// call this lands at ~10-15s.
//
// Once enrichment is done, `detect()` runs and the report renders.
// Per-row Fix buttons (Phase 2) dispatch the appropriate action;
// successful applies splice the row out and decrement the matching
// counter (drift or review) in the summary header — no toast, no
// confirm, trust-fire per operator decision.
//
// Body-only: chrome (email, sign-out, navigation back to the queue)
// has moved to the shared toolbar + tab bar in TabbedShell.
//
// Design doc: `extension/docs/sync-design.md`.

import { useCallback, useMemo, useState } from 'react';
import { ExtensionApiError, getSyncData, type SyncDataBundle } from '../lib/extensionApi';
import { readKindooSession, type KindooSessionError } from '../content/kindoo/auth';
import { getEnvironments, listAllEnvironmentUsers } from '../content/kindoo/endpoints';
import type { KindooEnvironment } from '../content/kindoo/endpoints';
import { KindooApiError } from '../content/kindoo/client';
import {
  detect,
  type Discrepancy,
  type DetectResult,
  type DiscrepancyCode,
  type Severity,
} from '../content/kindoo/sync/detector';
import {
  applyFix,
  fixActionsFor,
  type DispatchContext,
  type FixAction,
} from '../content/kindoo/sync/fix';
import {
  buildRuleDoorMap,
  enrichUsersWithDerivedBuildings,
} from '../content/kindoo/sync/buildingsFromDoors';
import { identifyActiveSite, type ActiveSite } from '../content/kindoo/sync/activeSite';
import type { KindooSession } from '../content/kindoo/auth';

type Step =
  | { kind: 'idle' }
  | { kind: 'loading'; progress: string | null }
  | {
      kind: 'report';
      result: DetectResult;
      ctx: DispatchContext;
      activeSiteLabel: string;
    }
  | { kind: 'error'; message: string }
  | { kind: 'no-kindoo'; error: KindooSessionError }
  | { kind: 'unknown-site' };

/** Update the loading progress text every Nth user. With 313 users +
 * concurrency=4 we'd get 313 React state updates a few hundred ms
 * apart; throttling to every 10 keeps the reconciler responsive. */
const PROGRESS_UPDATE_EVERY = 10;

type FilterMode = 'all' | 'drift' | 'review';

/** Sentinel for "no code filter" — keep separate from the union so we
 * can spread `DiscrepancyCode` into the dropdown options without
 * carving out a "doesn't match any row" value. */
type CodeFilter = 'all' | DiscrepancyCode;

/** Order of the dropdown options. Mirrors the order in `DiscrepancyCode`
 * so the labels read top-to-bottom in the order the detector files
 * them. */
const CODE_FILTER_OPTIONS: readonly DiscrepancyCode[] = [
  'sba-only',
  'kindoo-only',
  'kindoo-unparseable',
  'scope-mismatch',
  'type-mismatch',
  'buildings-mismatch',
  'extra-kindoo-calling',
];

/** Per-row fix state. `idle` → buttons visible; `applying` → in flight;
 * `error` → inline error + Retry; success removes the row entirely so
 * there is no `success` state to render. */
type RowState =
  | { kind: 'idle' }
  | { kind: 'applying'; action: FixAction }
  | { kind: 'error'; message: string; lastAction: FixAction };

function describeExtensionError(err: unknown): string {
  if (err instanceof ExtensionApiError) return `${err.code}: ${err.message}`;
  if (err instanceof Error) return err.message;
  return String(err);
}

function describeKindooError(err: unknown): string {
  if (err instanceof KindooApiError) return `Kindoo API (${err.code}): ${err.message}`;
  if (err instanceof Error) return err.message;
  return String(err);
}

export function SyncPanel() {
  const [step, setStep] = useState<Step>({ kind: 'idle' });
  const [filter, setFilter] = useState<FilterMode>('all');
  const [codeFilter, setCodeFilter] = useState<CodeFilter>('all');

  const runSync = useCallback(async () => {
    setStep({ kind: 'loading', progress: null });

    const sessionResult = readKindooSession();
    if (!sessionResult.ok) {
      setStep({ kind: 'no-kindoo', error: sessionResult.error });
      return;
    }
    const session = sessionResult.session;

    try {
      // Phase A: parallel read of SBA bundle + Kindoo bulk listing +
      // env metadata. The rule door map depends on the buildings list
      // (to know which RIDs to fetch), so it kicks off once the
      // bundle resolves.
      const [bundle, kindooUsers, envs] = await Promise.all([
        getSyncData(),
        listAllEnvironmentUsers(session),
        getEnvironments(session),
      ]);

      // Phase A.5: identify which Kindoo site the active session is
      // pointed at. On `unknown` we short-circuit before the expensive
      // door-grant enrichment loop — there's nothing useful to compare.
      const activeSite = identifyActiveSite(session.eid, bundle.stake, bundle.kindooSites);
      if (activeSite.kind === 'unknown') {
        setStep({ kind: 'unknown-site' });
        return;
      }

      // Phase B: rule door map. Drives every AccessRule referenced by
      // an SBA building via `KindooGetEnvRuleWithEntryPointsFormatted`.
      // csnorth has 4 rules → 4 calls; cheap.
      //
      // Multi-site: scope the rule fetch to buildings owned by the
      // active site. Issuing a foreign rule_id against the home EID
      // (or vice-versa) hits `KindooGetEnvRuleWithEntryPointsFormatted`
      // with a rule that doesn't exist on that env → HTTP 303
      // ObjectNotFound. The downstream `derivedBuildings` enrichment
      // needs the same filter for the same reason: a user on the home
      // site would otherwise pick up foreign buildings via stale
      // rule_id collisions.
      const siteBuildings = filterBuildingsForActiveSite(bundle.buildings, activeSite);
      const ruleIds = collectRuleIds(siteBuildings);
      const ruleDoorMap = await buildRuleDoorMap(session, session.eid, ruleIds);

      // Phase C: enrich each user with derivedBuildings. ~313 calls
      // at concurrency=4; the operator sees "Reading Kindoo user N of
      // M…" tick along.
      const enriched = await enrichUsersWithDerivedBuildings(
        session,
        session.eid,
        kindooUsers,
        ruleDoorMap,
        siteBuildings,
        {
          concurrency: 4,
          onProgress: (completed, total) => {
            if (completed === total || completed === 1 || completed % PROGRESS_UPDATE_EVERY === 0) {
              setStep({
                kind: 'loading',
                progress: `Reading Kindoo user ${completed} of ${total}…`,
              });
            }
          },
        },
      );

      const result = detect({ ...bundle, kindooUsers: enriched, activeSite });
      const ctx = buildDispatchContext(bundle, envs, session);
      const activeSiteLabel = describeActiveSite(activeSite, bundle);
      setStep({ kind: 'report', result, ctx, activeSiteLabel });
    } catch (err) {
      const message =
        err instanceof KindooApiError ? describeKindooError(err) : describeExtensionError(err);
      setStep({ kind: 'error', message });
    }
  }, []);

  return (
    <div className="sba-body" data-testid="sba-sync">
      <SyncBody
        step={step}
        filter={filter}
        codeFilter={codeFilter}
        onRun={() => void runSync()}
        onFilter={setFilter}
        onCodeFilter={setCodeFilter}
      />
    </div>
  );
}

function buildDispatchContext(
  bundle: SyncDataBundle,
  envs: KindooEnvironment[],
  session: KindooSession,
): DispatchContext {
  return {
    stake: bundle.stake,
    wards: bundle.wards,
    buildings: bundle.buildings,
    // T-42: thread the foreign-site directory through so the
    // Kindoo-side fix path can filter `unionSeatBuildings` by the
    // active session's site.
    kindooSites: bundle.kindooSites,
    envs,
    session,
  };
}

/**
 * Human-readable label for the active Kindoo site, surfaced in the
 * report header so the operator knows which site's drift they're
 * looking at.
 */
function describeActiveSite(activeSite: ActiveSite, bundle: SyncDataBundle): string {
  if (activeSite.kind === 'home') return 'Home';
  if (activeSite.kind === 'foreign') {
    const site = bundle.kindooSites.find((s) => s.id === activeSite.siteId);
    return site?.display_name ?? activeSite.siteId;
  }
  return '(unknown — not configured in SBA)';
}

/** Filter buildings to those owned by the active Kindoo site. Home
 * active → buildings whose `kindoo_site_id` is null / absent; foreign
 * active → buildings whose `kindoo_site_id === activeSite.siteId`.
 *
 * Without this filter the `collectRuleIds` step below issues foreign
 * rule_ids against the home EID (or home rule_ids against a foreign
 * EID) and Kindoo returns HTTP 303 ObjectNotFound — exactly the bug
 * that made Sync unreachable for multi-site managers. */
function filterBuildingsForActiveSite(
  buildings: SyncDataBundle['buildings'],
  activeSite: ActiveSite,
): SyncDataBundle['buildings'] {
  if (activeSite.kind === 'home') {
    return buildings.filter((b) => b.kindoo_site_id === null || b.kindoo_site_id === undefined);
  }
  if (activeSite.kind === 'foreign') {
    return buildings.filter((b) => b.kindoo_site_id === activeSite.siteId);
  }
  // 'unknown' is short-circuited upstream — defensive empty.
  return [];
}

/** Collect distinct RuleIDs referenced by the given buildings. Used as
 * the input to `buildRuleDoorMap` — we only fetch door sets for rules
 * an SBA building actually maps to. Caller passes in the
 * already-site-filtered subset; this function does no site filtering
 * of its own. */
function collectRuleIds(buildings: SyncDataBundle['buildings']): number[] {
  const out = new Set<number>();
  for (const b of buildings) {
    const rid = b.kindoo_rule?.rule_id;
    if (typeof rid === 'number') out.add(rid);
  }
  return Array.from(out);
}

interface BodyProps {
  step: Step;
  filter: FilterMode;
  codeFilter: CodeFilter;
  onRun: () => void;
  onFilter: (f: FilterMode) => void;
  onCodeFilter: (c: CodeFilter) => void;
}

function SyncBody({ step, filter, codeFilter, onRun, onFilter, onCodeFilter }: BodyProps) {
  if (step.kind === 'idle') {
    return (
      <div data-testid="sba-sync-idle">
        <p>
          Compares SBA seats with Kindoo users and reports drift. Fix buttons apply changes one row
          at a time — no confirmation, no undo. Run a fresh sync to verify.
        </p>
        <button
          type="button"
          className="sba-btn sba-btn-primary"
          onClick={onRun}
          data-testid="sba-sync-run"
        >
          Run Sync
        </button>
      </div>
    );
  }
  if (step.kind === 'loading') {
    return (
      <div data-testid="sba-sync-loading">
        <p className="sba-muted">Reading SBA + Kindoo…</p>
        {step.progress !== null ? (
          <p className="sba-muted" data-testid="sba-sync-progress" aria-live="polite">
            {step.progress}
          </p>
        ) : null}
      </div>
    );
  }
  if (step.kind === 'no-kindoo') {
    return (
      <div data-testid="sba-sync-no-kindoo">
        <p className="sba-error">
          {step.error === 'no-token'
            ? 'Sign into Kindoo first.'
            : "Open a specific Kindoo site (click into one from the My Sites list) and try again. Sync can't tell which site you're working on otherwise."}
        </p>
        <button type="button" className="sba-btn" onClick={onRun}>
          Retry
        </button>
      </div>
    );
  }
  if (step.kind === 'error') {
    return (
      <div data-testid="sba-sync-error">
        <p className="sba-error">Sync failed: {step.message}</p>
        <button type="button" className="sba-btn" onClick={onRun} data-testid="sba-sync-retry">
          Retry
        </button>
      </div>
    );
  }
  if (step.kind === 'unknown-site') {
    return (
      <div data-testid="sba-sync-unknown-site">
        <p className="sba-error" data-testid="sba-sync-unknown-site-message">
          This Kindoo site is not configured in SBA. Add it in Configuration → Kindoo Sites or
          switch to a known site.
        </p>
        <button type="button" className="sba-btn" onClick={onRun} data-testid="sba-sync-retry">
          Retry
        </button>
      </div>
    );
  }
  return (
    <ReportView
      result={step.result}
      ctx={step.ctx}
      activeSiteLabel={step.activeSiteLabel}
      filter={filter}
      codeFilter={codeFilter}
      onFilter={onFilter}
      onCodeFilter={onCodeFilter}
    />
  );
}

interface ReportProps {
  result: DetectResult;
  ctx: DispatchContext;
  activeSiteLabel: string;
  filter: FilterMode;
  codeFilter: CodeFilter;
  onFilter: (f: FilterMode) => void;
  onCodeFilter: (c: CodeFilter) => void;
}

function ReportView({
  result,
  ctx,
  activeSiteLabel,
  filter,
  codeFilter,
  onFilter,
  onCodeFilter,
}: ReportProps) {
  // Splice-on-success: once a fix applies, drop the row from the
  // rendered list. The detector is not re-run; the operator triggers
  // a fresh sync to get a clean state.
  const [removed, setRemoved] = useState<Set<string>>(() => new Set());
  const [rowStates, setRowStates] = useState<Record<string, RowState>>({});

  const visibleDiscrepancies = useMemo(
    () => result.discrepancies.filter((d) => !removed.has(d.canonical)),
    [result.discrepancies, removed],
  );
  const driftCount = useMemo(
    () => visibleDiscrepancies.filter((d) => d.severity === 'drift').length,
    [visibleDiscrepancies],
  );
  const reviewCount = useMemo(
    () => visibleDiscrepancies.filter((d) => d.severity === 'review').length,
    [visibleDiscrepancies],
  );
  const filtered = useMemo(() => {
    return visibleDiscrepancies.filter((d) => {
      if (filter === 'drift' && d.severity !== 'drift') return false;
      if (filter === 'review' && d.severity !== 'review') return false;
      if (codeFilter !== 'all' && d.code !== codeFilter) return false;
      return true;
    });
  }, [filter, codeFilter, visibleDiscrepancies]);
  // Distinguish "report is empty" (both sides agree — show the
  // existing reassuring message) from "filters combine to zero rows"
  // (show a filter-specific hint so the operator knows the data is
  // there, just hidden).
  const hasAnyDiscrepancies = visibleDiscrepancies.length > 0;

  const handleFix = useCallback(
    async (d: Discrepancy, action: FixAction) => {
      setRowStates((prev) => ({ ...prev, [d.canonical]: { kind: 'applying', action } }));
      const outcome = await applyFix(d, action, ctx);
      if (outcome.ok) {
        setRemoved((prev) => {
          const next = new Set(prev);
          next.add(d.canonical);
          return next;
        });
        setRowStates((prev) => {
          const next = { ...prev };
          delete next[d.canonical];
          return next;
        });
      } else {
        setRowStates((prev) => ({
          ...prev,
          [d.canonical]: { kind: 'error', message: outcome.error, lastAction: action },
        }));
      }
    },
    [ctx],
  );

  return (
    <div data-testid="sba-sync-report">
      <p className="sba-sync-active-site" data-testid="sba-sync-active-site">
        Reading from: <strong>{activeSiteLabel}</strong>
      </p>
      <p className="sba-sync-summary" data-testid="sba-sync-summary">
        Found <strong>{driftCount}</strong> drift item{driftCount === 1 ? '' : 's'},{' '}
        <strong>{reviewCount}</strong> need review. SBA: <strong>{result.seatCount}</strong> seats.
        Kindoo: <strong>{result.kindooCount}</strong> users.
      </p>
      <div className="sba-sync-filters" role="group" aria-label="Filter discrepancies">
        <FilterChip current={filter} value="all" label="All" onFilter={onFilter} />
        <FilterChip current={filter} value="drift" label="Drift only" onFilter={onFilter} />
        <FilterChip current={filter} value="review" label="Review only" onFilter={onFilter} />
        <select
          className="sba-code-filter"
          aria-label="Filter by code"
          value={codeFilter}
          onChange={(e) => onCodeFilter(e.target.value as CodeFilter)}
          data-testid="sba-sync-code-filter"
        >
          <option value="all">All codes</option>
          {CODE_FILTER_OPTIONS.map((code) => (
            <option key={code} value={code}>
              {code}
            </option>
          ))}
        </select>
      </div>
      {filtered.length === 0 ? (
        <p className="sba-empty" data-testid="sba-sync-empty">
          {hasAnyDiscrepancies
            ? 'No discrepancies match the current filters.'
            : 'No discrepancies to show.'}
        </p>
      ) : (
        <ul className="sba-sync-list" data-testid="sba-sync-list">
          {filtered.map((d) => (
            <li key={d.canonical}>
              <DiscrepancyRow
                discrepancy={d}
                state={rowStates[d.canonical] ?? { kind: 'idle' }}
                onFix={(action) => void handleFix(d, action)}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

interface FilterChipProps {
  current: FilterMode;
  value: FilterMode;
  label: string;
  onFilter: (f: FilterMode) => void;
}

function FilterChip({ current, value, label, onFilter }: FilterChipProps) {
  const active = current === value;
  return (
    <button
      type="button"
      className={active ? 'sba-chip sba-chip-active' : 'sba-chip'}
      onClick={() => onFilter(value)}
      aria-pressed={active}
      data-testid={`sba-sync-filter-${value}`}
    >
      {label}
    </button>
  );
}

interface DiscrepancyRowProps {
  discrepancy: Discrepancy;
  state: RowState;
  onFix: (action: FixAction) => void;
}

function DiscrepancyRow({ discrepancy, state, onFix }: DiscrepancyRowProps) {
  const severityClass = discrepancy.severity === 'drift' ? 'sba-badge-remove' : 'sba-badge-temp';
  const actions = fixActionsFor(discrepancy);
  // Auto seats: Church Access Automation owns direct door grants — the
  // extension can't write them. The Kindoo-side button is disabled on:
  //   - type-mismatch when either side is auto
  //   - buildings-mismatch when the SBA seat is auto
  // For buildings-mismatch on auto where `derivedBuildings === null`
  // the SBA-side write has no valid source either, so disable both
  // buttons.
  const isAutoBuildingsMismatch =
    discrepancy.code === 'buildings-mismatch' &&
    (discrepancy.sba?.type === 'auto' || discrepancy.kindoo?.intendedType === 'auto');
  const autoLockedKindoo =
    (discrepancy.code === 'type-mismatch' &&
      (discrepancy.sba?.type === 'auto' || discrepancy.kindoo?.intendedType === 'auto')) ||
    isAutoBuildingsMismatch;
  const autoLockedSba =
    isAutoBuildingsMismatch &&
    (discrepancy.kindoo?.derivedBuildings === null ||
      discrepancy.kindoo?.derivedBuildings === undefined);

  return (
    <div
      className="sba-sync-row"
      data-testid={`sba-sync-row-${discrepancy.canonical}`}
      data-severity={discrepancy.severity}
    >
      <div className="sba-sync-row-head">
        <strong className="sba-sync-row-email">{discrepancy.displayEmail}</strong>
        <span className={`sba-badge ${severityClass}`}>{severityLabel(discrepancy.severity)}</span>
        <span className="sba-badge sba-badge-code">{discrepancy.code}</span>
      </div>
      <div className="sba-sync-sides">
        <SideBlock
          title="SBA"
          empty={!discrepancy.sba}
          content={
            discrepancy.sba ? (
              <>
                <div>
                  <em>scope:</em> {discrepancy.sba.scope}
                </div>
                <div>
                  <em>type:</em> {discrepancy.sba.type}
                </div>
                {discrepancy.sba.callings.length > 0 ? (
                  <div>
                    <em>callings:</em> {discrepancy.sba.callings.join(', ')}
                  </div>
                ) : null}
                {discrepancy.sba.reason ? (
                  <div>
                    <em>reason:</em> {discrepancy.sba.reason}
                  </div>
                ) : null}
                <div>
                  <em>buildings:</em>{' '}
                  {discrepancy.sba.buildingNames.length > 0
                    ? discrepancy.sba.buildingNames.join(', ')
                    : '(none)'}
                </div>
              </>
            ) : null
          }
        />
        <SideBlock
          title="Kindoo"
          empty={!discrepancy.kindoo}
          content={
            discrepancy.kindoo ? (
              <>
                <div>
                  <em>description:</em> {discrepancy.kindoo.description || '(empty)'}
                </div>
                <div>
                  <em>tempUser:</em> {discrepancy.kindoo.isTempUser ? 'yes' : 'no'}
                </div>
                <div>
                  <em>intended type:</em> {discrepancy.kindoo.intendedType ?? '(unresolved)'}
                </div>
                <div>
                  <em>rule IDs:</em>{' '}
                  {discrepancy.kindoo.ruleIds.length > 0
                    ? discrepancy.kindoo.ruleIds.join(', ')
                    : '(none)'}
                </div>
              </>
            ) : null
          }
        />
      </div>
      <p className="sba-sync-reason">{discrepancy.reason}</p>
      <FixActions
        canonical={discrepancy.canonical}
        actions={actions}
        state={state}
        autoLockedKindoo={autoLockedKindoo}
        autoLockedSba={autoLockedSba}
        onFix={onFix}
      />
    </div>
  );
}

interface FixActionsProps {
  canonical: string;
  actions: FixAction[];
  state: RowState;
  /** Disable the Kindoo-side button (Church Access Automation owns
   * auto-seat door grants). */
  autoLockedKindoo: boolean;
  /** Disable the SBA-side button (auto buildings-mismatch where
   * `derivedBuildings` failed — no valid source to send). */
  autoLockedSba: boolean;
  onFix: (action: FixAction) => void;
}

function FixActions({
  canonical,
  actions,
  state,
  autoLockedKindoo,
  autoLockedSba,
  onFix,
}: FixActionsProps) {
  if (actions.length === 0) return null;

  if (state.kind === 'applying') {
    return (
      <div
        className="sba-sync-fix-row"
        data-testid={`sba-sync-fix-applying-${canonical}`}
        aria-live="polite"
      >
        <span className="sba-muted">Applying {state.action.label}…</span>
      </div>
    );
  }

  if (state.kind === 'error') {
    return (
      <div className="sba-sync-fix-row" data-testid={`sba-sync-fix-error-${canonical}`}>
        <span className="sba-error sba-sync-fix-error" role="alert">
          {state.message}
        </span>
        <button
          type="button"
          className="sba-btn"
          onClick={() => onFix(state.lastAction)}
          data-testid={`sba-sync-fix-retry-${canonical}`}
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="sba-sync-fix-row">
      {actions.map((a) => {
        const lockedKindoo = autoLockedKindoo && a.side === 'kindoo';
        const lockedSba = autoLockedSba && a.side === 'sba';
        const disabled = lockedKindoo || lockedSba;
        const title = lockedKindoo
          ? 'auto seats provisioned by Church Access Automation; not modifiable here.'
          : lockedSba
            ? 'door-grant derivation failed; cannot determine the correct building set — re-run Sync.'
            : undefined;
        return (
          <button
            key={a.testId}
            type="button"
            className={a.side === 'sba' ? 'sba-btn sba-btn-primary' : 'sba-btn sba-btn-success'}
            onClick={() => onFix(a)}
            disabled={disabled}
            title={title}
            data-testid={`sba-sync-fix-${a.testId}-${canonical}`}
          >
            {a.label}
          </button>
        );
      })}
    </div>
  );
}

function SideBlock({
  title,
  empty,
  content,
}: {
  title: string;
  empty: boolean;
  content: React.ReactNode;
}) {
  return (
    <div className="sba-sync-side">
      <div className="sba-sync-side-title">{title}</div>
      {empty ? <div className="sba-muted">— absent —</div> : <div>{content}</div>}
    </div>
  );
}

function severityLabel(s: Severity): string {
  return s === 'drift' ? 'Drift' : 'Review';
}
