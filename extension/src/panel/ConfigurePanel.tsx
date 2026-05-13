// First-run configuration wizard for v2.1.
//
// Two sequential steps inside the same slide-over:
//   1. Site verification — read EID from web.kindoo.tech's localStorage,
//      call KindooGetEnvironments, match against `stake.stake_name`.
//      Mismatch is a hard block (no override) — wrong-site provisioning
//      would grant access in the wrong physical buildings.
//   2. Building → Access Rule mapping — call KindooGetEnvironmentRules,
//      render one row per SBA building, persist via SW writeBatch.
//
// State machine (`step`):
//   - 'init'                          loading the stake + buildings + EID
//   - { kind: 'verify', ... }         Step 1 rendered
//   - { kind: 'rules', ... }          Step 2 rendered
//   - { kind: 'saving', ... }         Save in flight
//   - { kind: 'error', ... }          recoverable fetch error in Step 1
//
// The component owns the wizard's local state; on `Save` success it
// fires `onComplete()` so the parent (App) can flip back to Queue.

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Building, Stake } from '@kindoo/shared';
import { ExtensionApiError, getStakeConfig, writeKindooConfig } from '../lib/extensionApi';
import { readKindooSession, type KindooSessionError } from '../content/kindoo/auth';
import {
  getEnvironments,
  getEnvironmentRules,
  type KindooAccessRule,
} from '../content/kindoo/endpoints';
import { KindooApiError } from '../content/kindoo/client';

interface ConfigurePanelProps {
  email: string | null | undefined;
  onComplete: () => void;
  onCancel?: () => void;
}

type VerifyState = {
  kind: 'verify';
  stake: Stake;
  buildings: Building[];
  kindooSiteName: string;
  match: boolean;
  eid: number;
};

type RulesState = {
  kind: 'rules';
  stake: Stake;
  buildings: Building[];
  kindooSiteName: string;
  eid: number;
  rules: KindooAccessRule[];
  /** buildingId → ruleId */
  assignments: Record<string, number>;
  saveError: string | null;
};

type Step =
  | { kind: 'init' }
  | VerifyState
  | RulesState
  | { kind: 'saving'; from: RulesState }
  | { kind: 'fatal'; message: string }
  | { kind: 'no-kindoo'; error: KindooSessionError };

function normaliseName(s: string): string {
  return s.trim().toLowerCase();
}

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

export function ConfigurePanel({ email, onComplete, onCancel }: ConfigurePanelProps) {
  const [step, setStep] = useState<Step>({ kind: 'init' });

  const beginLoad = useCallback(async () => {
    setStep({ kind: 'init' });

    const sessionResult = readKindooSession();
    if (!sessionResult.ok) {
      setStep({ kind: 'no-kindoo', error: sessionResult.error });
      return;
    }
    const session = sessionResult.session;

    let bundle: { stake: Stake; buildings: Building[] };
    try {
      bundle = await getStakeConfig();
    } catch (err) {
      setStep({
        kind: 'fatal',
        message: `Could not load stake config: ${describeExtensionError(err)}`,
      });
      return;
    }

    let envs: Awaited<ReturnType<typeof getEnvironments>>;
    try {
      envs = await getEnvironments(session);
    } catch (err) {
      setStep({
        kind: 'fatal',
        message: `Could not reach Kindoo: ${describeKindooError(err)}`,
      });
      return;
    }
    const env = envs.find((e) => e.EID === session.eid);
    const kindooSiteName = env ? env.Name : '';
    const match =
      kindooSiteName.length > 0 &&
      normaliseName(kindooSiteName) === normaliseName(bundle.stake.stake_name);

    setStep({
      kind: 'verify',
      stake: bundle.stake,
      buildings: bundle.buildings,
      kindooSiteName,
      match,
      eid: session.eid,
    });
  }, []);

  useEffect(() => {
    void beginLoad();
  }, [beginLoad]);

  const goToRules = useCallback(async (verify: VerifyState) => {
    const sessionResult = readKindooSession();
    if (!sessionResult.ok) {
      setStep({ kind: 'no-kindoo', error: sessionResult.error });
      return;
    }
    let rules: KindooAccessRule[];
    try {
      rules = await getEnvironmentRules(sessionResult.session, verify.eid);
    } catch (err) {
      setStep({
        kind: 'fatal',
        message: `Could not load Kindoo Access Rules: ${describeKindooError(err)}`,
      });
      return;
    }
    // Pre-fill assignments from any existing kindoo_rule on each building.
    const assignments: Record<string, number> = {};
    for (const b of verify.buildings) {
      const existing = b.kindoo_rule;
      if (existing && rules.some((r) => r.RID === existing.rule_id)) {
        assignments[b.building_id] = existing.rule_id;
      }
    }
    setStep({
      kind: 'rules',
      stake: verify.stake,
      buildings: verify.buildings,
      kindooSiteName: verify.kindooSiteName,
      eid: verify.eid,
      rules,
      assignments,
      saveError: null,
    });
  }, []);

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

  return (
    <main className="sba-panel" data-testid="sba-configure">
      <header className="sba-header">
        <div>
          <h1>Configure Kindoo</h1>
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
      <div className="sba-body">
        <ConfigureBody
          step={step}
          onRetry={() => void beginLoad()}
          onContinue={(v) => void goToRules(v)}
          onAssign={handleAssign}
          onSave={(rules) => void handleSave(rules)}
        />
      </div>
    </main>
  );
}

interface BodyProps {
  step: Step;
  onRetry: () => void;
  onContinue: (verify: VerifyState) => void;
  onAssign: (buildingId: string, ruleId: number | null) => void;
  onSave: (rules: RulesState) => void;
}

function ConfigureBody({ step, onRetry, onContinue, onAssign, onSave }: BodyProps) {
  if (step.kind === 'init') {
    return <p className="sba-muted">Loading…</p>;
  }
  if (step.kind === 'no-kindoo') {
    return (
      <div data-testid="sba-configure-no-kindoo">
        <p className="sba-error">
          {step.error === 'no-token'
            ? 'Sign into Kindoo first.'
            : 'Kindoo session not ready. Refresh web.kindoo.tech and retry.'}
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
  if (step.kind === 'verify') {
    return <VerifyStep state={step} onContinue={onContinue} />;
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

function VerifyStep({
  state,
  onContinue,
}: {
  state: VerifyState;
  onContinue: (s: VerifyState) => void;
}) {
  return (
    <div data-testid="sba-configure-verify">
      <h2 className="sba-configure-step-title">Step 1 of 2 — verify site</h2>
      <dl className="sba-configure-pair">
        <dt>SBA stake</dt>
        <dd>{state.stake.stake_name}</dd>
        <dt>Kindoo site</dt>
        <dd>{state.kindooSiteName || <em className="sba-muted">no site found for EID</em>}</dd>
      </dl>
      {state.match ? (
        <p className="sba-success-msg" data-testid="sba-configure-match">
          Site matches the SBA stake. You can continue.
        </p>
      ) : (
        <p className="sba-error" data-testid="sba-configure-mismatch">
          The Kindoo site does not match the SBA stake. Sign into the correct Kindoo site and retry.
        </p>
      )}
      <div className="sba-request-actions">
        <button
          type="button"
          className="sba-btn sba-btn-primary"
          disabled={!state.match}
          onClick={() => onContinue(state)}
          data-testid="sba-configure-continue"
        >
          Continue
        </button>
      </div>
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
      <h2 className="sba-configure-step-title">Step 2 of 2 — assign rules</h2>
      <p className="sba-muted">
        Pick the Kindoo Access Rule for each SBA building. Every building must have a rule before
        saving.
      </p>
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
      {state.saveError ? (
        <p role="alert" className="sba-error" data-testid="sba-configure-save-error">
          {state.saveError}
        </p>
      ) : null}
      <div className="sba-request-actions">
        <button
          type="button"
          className="sba-btn sba-btn-primary"
          disabled={!allAssigned}
          onClick={() => onSave(state)}
          data-testid="sba-configure-save"
        >
          Save
        </button>
      </div>
    </div>
  );
}
