// First-run + reconfigure wizard for v2.1 / Phase 5.
//
// One wizard run = one Kindoo site. Which site is determined by the
// active Kindoo session — the operator switches sites via Kindoo's own
// UI and reopens the panel; the wizard scopes to whichever site is
// active. Buildings whose `kindoo_site_id` doesn't match the active
// site are filtered out (a foreign-site wizard never prompts for home
// buildings, and vice versa).
//
// State machine (`step`):
//   - 'init'                          loading the stake + buildings + EID
//   - { kind: 'unknown-site', ... }   active Kindoo site isn't configured in SBA
//   - { kind: 'rules', ... }          rule-mapping step rendered
//   - { kind: 'saving', ... }         Save in flight
//   - { kind: 'fatal', ... }          recoverable fetch error
//   - { kind: 'no-kindoo', ... }      Kindoo session missing
//
// The component owns the wizard's local state; on `Save` success it
// fires `onComplete()` so the parent (App) re-renders into the tabbed
// shell.
//
// Two render modes:
//   - 'wizard' (first-run takeover): renders its own header + email
//     meta + optional Cancel button. App routes to this directly until
//     the stake is fully configured.
//   - 'tab' (gear tab inside TabbedShell): body-only — the shell's
//     toolbar + tab bar already supply the surrounding chrome.

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Building, Stake } from '@kindoo/shared';
import { ExtensionApiError, getStakeConfig, writeKindooConfig } from '../lib/extensionApi';
import { readKindooSession, type KindooSessionError } from '../content/kindoo/auth';
import {
  getEnvironments,
  getEnvironmentRules,
  type KindooAccessRule,
  type KindooEnvironment,
} from '../content/kindoo/endpoints';
import { KindooApiError } from '../content/kindoo/client';
import { resolveActiveKindooSite, type ActiveSiteResolution } from '../content/kindoo/siteCheck';

interface ConfigurePanelProps {
  email?: string | null | undefined;
  onComplete: () => void;
  onCancel?: () => void;
  /** 'wizard' = first-run full-takeover (own header + Cancel). 'tab' =
   * gear-tab body, no header (TabbedShell owns chrome). Defaults to
   * 'wizard' for backwards compatibility with existing tests. */
  mode?: 'wizard' | 'tab';
}

type RulesState = {
  kind: 'rules';
  stake: Stake;
  /** Buildings filtered to the active site only. */
  buildings: Building[];
  /** Active Kindoo session site classification — drives both the header
   * label and the save's `kindooSiteId` discriminator. */
  active: ActiveSiteResolution & ({ kind: 'home' } | { kind: 'foreign' });
  /** Active session's EID, persisted onto stake.kindoo_config (home) or
   * the foreign KindooSite doc (foreign auto-populate). */
  eid: number;
  /** Active session's Kindoo `Name`, persisted on home save. */
  kindooSiteName: string;
  rules: KindooAccessRule[];
  /** buildingId → ruleId */
  assignments: Record<string, number>;
  saveError: string | null;
};

type Step =
  | { kind: 'init' }
  | RulesState
  | { kind: 'saving'; from: RulesState }
  | { kind: 'fatal'; message: string }
  | { kind: 'no-kindoo'; error: KindooSessionError }
  | {
      kind: 'unknown-site';
      /** Active site's display name from `getEnvironments()`. Empty when no
       * env matched the active EID. */
      activeSiteName: string;
    };

function describeKindooError(err: unknown): string {
  if (err instanceof KindooApiError) {
    return `Kindoo API error (${err.code}): ${err.message}`;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

function describeExtensionError(err: unknown): string {
  if (err instanceof ExtensionApiError) {
    return `${err.code}: ${err.message}`;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Filter buildings to the active Kindoo site. `null` / undefined
 * `kindoo_site_id` means home; a string value points at a foreign
 * KindooSite doc id. Phase 5 — wizards see only their site's buildings. */
function filterBuildingsForSite(
  buildings: Building[],
  active: ActiveSiteResolution & ({ kind: 'home' } | { kind: 'foreign' }),
): Building[] {
  if (active.kind === 'home') {
    return buildings.filter((b) => b.kindoo_site_id === null || b.kindoo_site_id === undefined);
  }
  return buildings.filter((b) => b.kindoo_site_id === active.siteId);
}

export function ConfigurePanel({
  email,
  onComplete,
  onCancel,
  mode = 'wizard',
}: ConfigurePanelProps) {
  const [step, setStep] = useState<Step>({ kind: 'init' });

  const beginLoad = useCallback(async () => {
    setStep({ kind: 'init' });

    const sessionResult = readKindooSession();
    if (!sessionResult.ok) {
      setStep({ kind: 'no-kindoo', error: sessionResult.error });
      return;
    }
    const session = sessionResult.session;

    let bundle: Awaited<ReturnType<typeof getStakeConfig>>;
    try {
      bundle = await getStakeConfig();
    } catch (err) {
      setStep({
        kind: 'fatal',
        message: `Could not load stake config: ${describeExtensionError(err)}`,
      });
      return;
    }

    let envs: KindooEnvironment[];
    try {
      envs = await getEnvironments(session);
    } catch (err) {
      setStep({
        kind: 'fatal',
        message: `Could not reach Kindoo: ${describeKindooError(err)}`,
      });
      return;
    }

    const active = resolveActiveKindooSite({
      session,
      envs,
      stake: bundle.stake,
      kindooSites: bundle.kindooSites,
    });

    if (active.kind === 'unknown') {
      setStep({ kind: 'unknown-site', activeSiteName: active.activeSiteName });
      return;
    }

    // Active = home | foreign. Load this site's rules + filter buildings.
    let rules: KindooAccessRule[];
    try {
      rules = await getEnvironmentRules(session, session.eid);
    } catch (err) {
      setStep({
        kind: 'fatal',
        message: `Could not load Kindoo Access Rules: ${describeKindooError(err)}`,
      });
      return;
    }

    const buildings = filterBuildingsForSite(bundle.buildings, active);
    // Pre-fill assignments from any existing kindoo_rule on each building.
    const assignments: Record<string, number> = {};
    for (const b of buildings) {
      const existing = b.kindoo_rule;
      if (existing && rules.some((r) => r.RID === existing.rule_id)) {
        assignments[b.building_id] = existing.rule_id;
      }
    }

    const env = envs.find((e) => e.EID === session.eid);
    const kindooSiteName = env ? env.Name : '';

    setStep({
      kind: 'rules',
      stake: bundle.stake,
      buildings,
      active,
      eid: session.eid,
      kindooSiteName,
      rules,
      assignments,
      saveError: null,
    });
  }, []);

  useEffect(() => {
    void beginLoad();
  }, [beginLoad]);

  const handleAssign = useCallback((buildingId: string, ruleId: number | null) => {
    setStep((prev) => {
      if (prev.kind !== 'rules') return prev;
      const next = { ...prev.assignments };
      if (ruleId === null) {
        delete next[buildingId];
      } else {
        next[buildingId] = ruleId;
      }
      return { ...prev, assignments: next, saveError: null };
    });
  }, []);

  const handleSave = useCallback(
    async (current: RulesState) => {
      setStep({ kind: 'saving', from: current });
      const buildingRules = current.buildings.map((b) => {
        const ruleId = current.assignments[b.building_id]!;
        const rule = current.rules.find((r) => r.RID === ruleId)!;
        return {
          buildingId: b.building_id,
          ruleId: rule.RID,
          ruleName: rule.Name,
        };
      });
      try {
        await writeKindooConfig({
          kindooSiteId: current.active.kind === 'home' ? null : current.active.siteId,
          siteId: current.eid,
          siteName: current.kindooSiteName,
          buildingRules,
        });
        onComplete();
      } catch (err) {
        setStep({
          ...current,
          saveError: `Save failed: ${describeExtensionError(err)}`,
        });
      }
    },
    [onComplete],
  );

  const headerLabel = useMemo(() => {
    if (step.kind === 'rules') return `Configuring: ${step.active.displayName}`;
    if (step.kind === 'saving') return `Configuring: ${step.from.active.displayName}`;
    return 'Configure Kindoo';
  }, [step]);

  const body = (
    <div className="sba-body" data-testid="sba-configure">
      <ConfigureBody
        step={step}
        onRetry={() => void beginLoad()}
        onAssign={handleAssign}
        onSave={(rules) => void handleSave(rules)}
      />
    </div>
  );

  if (mode === 'tab') return body;

  return (
    <main className="sba-panel">
      <header className="sba-header">
        <div>
          <h1>{headerLabel}</h1>
          {email ? <div className="sba-header-meta">{email}</div> : null}
        </div>
        {onCancel ? (
          <button
            type="button"
            className="sba-btn"
            onClick={onCancel}
            data-testid="sba-configure-cancel"
          >
            Cancel
          </button>
        ) : null}
      </header>
      {body}
    </main>
  );
}

interface BodyProps {
  step: Step;
  onRetry: () => void;
  onAssign: (buildingId: string, ruleId: number | null) => void;
  onSave: (rules: RulesState) => void;
}

function ConfigureBody({ step, onRetry, onAssign, onSave }: BodyProps) {
  if (step.kind === 'init') {
    return <p className="sba-muted">Loading…</p>;
  }
  if (step.kind === 'no-kindoo') {
    return (
      <div data-testid="sba-configure-no-kindoo">
        <p className="sba-error">
          {step.error === 'no-token'
            ? 'Sign into Kindoo first.'
            : "Open a specific Kindoo site (click into one from the My Sites list) and try again. The wizard can't tell which site you're configuring otherwise."}
        </p>
        <button type="button" className="sba-btn" onClick={onRetry}>
          Retry
        </button>
      </div>
    );
  }
  if (step.kind === 'fatal') {
    return (
      <div data-testid="sba-configure-fatal">
        <p className="sba-error">{step.message}</p>
        <button type="button" className="sba-btn" onClick={onRetry}>
          Retry
        </button>
      </div>
    );
  }
  if (step.kind === 'unknown-site') {
    return (
      <div data-testid="sba-configure-unknown-site">
        <p className="sba-error">
          This Kindoo site (<code>{step.activeSiteName || 'unknown'}</code>) isn&rsquo;t configured
          in SBA. Add it in Configuration → Kindoo Sites first.
        </p>
        <button type="button" className="sba-btn" onClick={onRetry}>
          Retry
        </button>
      </div>
    );
  }
  if (step.kind === 'rules') {
    return <RulesStep state={step} onAssign={onAssign} onSave={onSave} />;
  }
  // saving
  return (
    <div data-testid="sba-configure-saving">
      <p className="sba-muted">Saving…</p>
    </div>
  );
}

function RulesStep({
  state,
  onAssign,
  onSave,
}: {
  state: RulesState;
  onAssign: (buildingId: string, ruleId: number | null) => void;
  onSave: (s: RulesState) => void;
}) {
  const allAssigned = useMemo(
    () => state.buildings.every((b) => typeof state.assignments[b.building_id] === 'number'),
    [state.buildings, state.assignments],
  );

  return (
    <div data-testid="sba-configure-rules">
      <p className="sba-muted">
        To configure a different Kindoo site, switch your Kindoo browser session to that site and
        reopen this panel.
      </p>
      <p className="sba-muted">
        Pick the Kindoo Access Rule for each SBA building. Every building must have a rule before
        saving.
      </p>
      {state.buildings.length === 0 ? (
        <p className="sba-muted" data-testid="sba-configure-no-buildings">
          No SBA buildings are assigned to this Kindoo site yet. Assign buildings to it in
          Configuration → Buildings, then reopen this panel.
        </p>
      ) : (
        <ul className="sba-configure-rule-list">
          {state.buildings.map((b) => {
            const selected = state.assignments[b.building_id];
            return (
              <li key={b.building_id} className="sba-configure-rule-row">
                <span className="sba-configure-rule-building">{b.building_name}</span>
                <select
                  className="sba-configure-rule-select"
                  value={selected ?? ''}
                  onChange={(e) => {
                    const v = e.target.value;
                    onAssign(b.building_id, v === '' ? null : Number(v));
                  }}
                  data-testid={`sba-configure-rule-${b.building_id}`}
                >
                  <option value="">Select a rule…</option>
                  {state.rules.map((r) => (
                    <option key={r.RID} value={r.RID}>
                      {r.Name}
                    </option>
                  ))}
                </select>
              </li>
            );
          })}
        </ul>
      )}
      {state.saveError ? (
        <p role="alert" className="sba-error" data-testid="sba-configure-save-error">
          {state.saveError}
        </p>
      ) : null}
      <div className="sba-request-actions">
        <button
          type="button"
          className="sba-btn sba-btn-primary"
          disabled={!allAssigned || state.buildings.length === 0}
          onClick={() => onSave(state)}
          data-testid="sba-configure-save"
        >
          Save
        </button>
      </div>
    </div>
  );
}
