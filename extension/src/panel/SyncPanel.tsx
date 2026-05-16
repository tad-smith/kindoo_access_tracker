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
import type { KindooSession } from '../content/kindoo/auth';

type Step =
  | { kind: 'idle' }
  | { kind: 'loading'; progress: string | null }
  | { kind: 'report'; result: DetectResult; ctx: DispatchContext }
  | { kind: 'error'; message: string }
  | { kind: 'no-kindoo'; error: KindooSessionError };

/** Update the loading progress text every Nth user. With 313 users +
 * concurrency=4 we'd get 313 React state updates a few hundred ms
 * apart; throttling to every 10 keeps the reconciler responsive. */
const PROGRESS_UPDATE_EVERY = 10;

type FilterMode = 'all' | 'drift' | 'review';

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

      // Phase B: rule door map. Drives every AccessRule referenced by
      // an SBA building via `KindooGetEnvRuleWithEntryPointsFormatted`.
      // csnorth has 4 rules → 4 calls; cheap.
      const ruleIds = collectRuleIds(bundle);
      const ruleDoorMap = await buildRuleDoorMap(session, session.eid, ruleIds);

      // Phase C: enrich each user with derivedBuildings. ~313 calls
      // at concurrency=4; the operator sees "Reading Kindoo user N of
      // M…" tick along.
      const enriched = await enrichUsersWithDerivedBuildings(
        session,
        session.eid,
        kindooUsers,
        ruleDoorMap,
        bundle.buildings,
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

      const result = detect({ ...bundle, kindooUsers: enriched });
      const ctx = buildDispatchContext(bundle, envs, session);
      setStep({ kind: 'report', result, ctx });
    } catch (err) {
      const message =
        err instanceof KindooApiError ? describeKindooError(err) : describeExtensionError(err);
      setStep({ kind: 'error', message });
    }
  }, []);

  return (
    <div className="sba-body" data-testid="sba-sync">
      <SyncBody step={step} filter={filter} onRun={() => void runSync()} onFilter={setFilter} />
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
    envs,
    session,
  };
}

/** Collect distinct RuleIDs referenced by SBA buildings. Used as the
 * input to `buildRuleDoorMap` — we only fetch door sets for rules an
 * SBA building actually maps to. */
function collectRuleIds(bundle: SyncDataBundle): number[] {
  const out = new Set<number>();
  for (const b of bundle.buildings) {
    const rid = b.kindoo_rule?.rule_id;
    if (typeof rid === 'number') out.add(rid);
  }
  return Array.from(out);
}

interface BodyProps {
  step: Step;
  filter: FilterMode;
  onRun: () => void;
  onFilter: (f: FilterMode) => void;
}

function SyncBody({ step, filter, onRun, onFilter }: BodyProps) {
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
            : 'Kindoo session not ready. Refresh web.kindoo.tech and retry.'}
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
  return <ReportView result={step.result} ctx={step.ctx} filter={filter} onFilter={onFilter} />;
}

interface ReportProps {
  result: DetectResult;
  ctx: DispatchContext;
  filter: FilterMode;
  onFilter: (f: FilterMode) => void;
}

function ReportView({ result, ctx, filter, onFilter }: ReportProps) {
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
    if (filter === 'all') return visibleDiscrepancies;
    return visibleDiscrepancies.filter((d) =>
      filter === 'drift' ? d.severity === 'drift' : d.severity === 'review',
    );
  }, [filter, visibleDiscrepancies]);

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
      <p className="sba-sync-summary" data-testid="sba-sync-summary">
        Found <strong>{driftCount}</strong> drift item{driftCount === 1 ? '' : 's'},{' '}
        <strong>{reviewCount}</strong> need review. SBA: <strong>{result.seatCount}</strong> seats.
        Kindoo: <strong>{result.kindooCount}</strong> users.
      </p>
      <div className="sba-sync-filters" role="group" aria-label="Filter discrepancies">
        <FilterChip current={filter} value="all" label="All" onFilter={onFilter} />
        <FilterChip current={filter} value="drift" label="Drift only" onFilter={onFilter} />
        <FilterChip current={filter} value="review" label="Review only" onFilter={onFilter} />
      </div>
      {filtered.length === 0 ? (
        <p className="sba-empty" data-testid="sba-sync-empty">
          No discrepancies to show.
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
  // Type-mismatch with `auto` on either side can't drive Kindoo from the
  // extension (Church Access Automation owns direct door grants). Mark
  // the Kindoo-side button disabled with a tooltip in that case.
  const autoLocked =
    discrepancy.code === 'type-mismatch' &&
    (discrepancy.sba?.type === 'auto' || discrepancy.kindoo?.intendedType === 'auto');

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
        autoLocked={autoLocked}
        onFix={onFix}
      />
    </div>
  );
}

interface FixActionsProps {
  canonical: string;
  actions: FixAction[];
  state: RowState;
  autoLocked: boolean;
  onFix: (action: FixAction) => void;
}

function FixActions({ canonical, actions, state, autoLocked, onFix }: FixActionsProps) {
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
        const isAutoLockedKindoo = autoLocked && a.side === 'kindoo';
        return (
          <button
            key={a.testId}
            type="button"
            className={a.side === 'sba' ? 'sba-btn sba-btn-primary' : 'sba-btn sba-btn-success'}
            onClick={() => onFix(a)}
            disabled={isAutoLockedKindoo}
            title={
              isAutoLockedKindoo
                ? 'auto seats provisioned by Church Access Automation; not modifiable here.'
                : undefined
            }
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
