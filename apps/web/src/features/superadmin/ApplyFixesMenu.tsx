// Per-row "Apply Fixes" control on the superadmin Stake List page
// (spec §5.4). A superadmin picks a platform maintenance fix from the
// dropdown; an Explain dialog confirms the target stake; Apply Fix runs
// the fix's callable; a Result dialog replaces the Explain dialog and
// renders the outcome GENERICALLY (key/value rows + warnings, or an
// error), with a Copy button.
//
// EXTENSIBILITY: the dropdown iterates `STAKE_FIXES`; the Explain dialog
// reads the selected fix's `label` + `description`; the mutation calls
// the fix's `callable`; the Result dialog renders `Record<string,
// unknown>` with no fix-specific code. Adding a fix is a one-object
// change in `fixes.ts`.

import { useState } from 'react';
import type { Stake } from '@kindoo/shared';
import { Button } from '../../components/ui/Button';
import { Dialog } from '../../components/ui/Dialog';
import { Select } from '../../components/ui/Select';
import { toast } from '../../lib/store/toast';
import { useApplyStakeFix } from './hooks';
import { STAKE_FIXES, findStakeFix, type StakeFix } from './fixes';
import { formatFixErrorText, formatFixResultText, toFixError, toFixResultView } from './fixResult';

interface ApplyFixesMenuProps {
  stake: Stake;
}

// The dialog runs through three content phases for a single selected
// fix: confirm (Explain) → success | error (Result). `null` = closed.
type Phase =
  | { kind: 'explain'; fix: StakeFix }
  | { kind: 'success'; fix: StakeFix; result: Record<string, unknown> }
  | { kind: 'error'; fix: StakeFix; error: unknown };

async function copyToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied to clipboard.', 'success');
  } catch {
    toast('Copy failed — clipboard unavailable.', 'error');
  }
}

export function ApplyFixesMenu({ stake }: ApplyFixesMenuProps) {
  const [phase, setPhase] = useState<Phase | null>(null);
  const mutation = useApplyStakeFix();

  // Native <select> as a one-shot action menu: selecting a fix opens the
  // Explain dialog, then the control resets to its placeholder so the
  // same fix can be re-selected later.
  function onSelect(e: React.ChangeEvent<HTMLSelectElement>) {
    const fix = findStakeFix(e.target.value);
    e.target.value = '';
    if (fix) setPhase({ kind: 'explain', fix });
  }

  function close() {
    setPhase(null);
    mutation.reset();
  }

  async function onApply(fix: StakeFix) {
    try {
      const result = await mutation.mutateAsync({
        callable: fix.callable,
        stakeId: stake.stake_id,
      });
      setPhase({ kind: 'success', fix, result });
    } catch (err) {
      setPhase({ kind: 'error', fix, error: err });
    }
  }

  const open = phase !== null;

  return (
    <div data-testid={`apply-fixes-${stake.stake_id}`}>
      <Select
        aria-label={`Apply fix to ${stake.stake_name}`}
        defaultValue=""
        onChange={onSelect}
        data-testid={`apply-fixes-select-${stake.stake_id}`}
      >
        <option value="" disabled>
          Apply Fixes…
        </option>
        {STAKE_FIXES.map((fix) => (
          <option key={fix.id} value={fix.id}>
            {fix.label}
          </option>
        ))}
      </Select>

      {phase ? (
        <Dialog
          open={open}
          onOpenChange={(next) => {
            if (!next) close();
          }}
          title={phase.fix.label}
        >
          {phase.kind === 'explain' ? (
            <ExplainBody
              fix={phase.fix}
              stake={stake}
              pending={mutation.isPending}
              onCancel={close}
              onApply={() => void onApply(phase.fix)}
            />
          ) : phase.kind === 'success' ? (
            <SuccessBody result={phase.result} onClose={close} />
          ) : (
            <ErrorBody error={phase.error} onClose={close} />
          )}
        </Dialog>
      ) : null}
    </div>
  );
}

interface ExplainBodyProps {
  fix: StakeFix;
  stake: Stake;
  pending: boolean;
  onCancel: () => void;
  onApply: () => void;
}

function ExplainBody({ fix, stake, pending, onCancel, onApply }: ExplainBodyProps) {
  return (
    <div className="flex flex-col gap-3" data-testid="apply-fixes-explain">
      <p className="text-sm text-kd-fg-1">{fix.description}</p>
      <p className="text-sm font-medium">
        Apply to <span data-testid="apply-fixes-target">{stake.stake_name}</span>?
      </p>
      <Dialog.Footer>
        <Button
          variant="secondary"
          disabled={pending}
          onClick={onCancel}
          data-testid="apply-fixes-cancel"
        >
          Cancel
        </Button>
        <Button disabled={pending} onClick={onApply} data-testid="apply-fixes-apply">
          {pending ? 'Applying…' : 'Apply Fix'}
        </Button>
      </Dialog.Footer>
    </div>
  );
}

function SuccessBody({
  result,
  onClose,
}: {
  result: Record<string, unknown>;
  onClose: () => void;
}) {
  const { rows, warnings } = toFixResultView(result);
  return (
    <div className="flex flex-col gap-3" data-testid="apply-fixes-result-success">
      <dl className="flex flex-col gap-1" data-testid="apply-fixes-result-rows">
        {rows.map((row) => (
          <div key={row.key} className="flex justify-between gap-3 text-sm">
            <dt className="font-medium text-kd-fg-2">{row.key}</dt>
            <dd className="text-right font-mono text-kd-fg-1">{row.value}</dd>
          </div>
        ))}
      </dl>

      {warnings.length > 0 ? (
        <div className="flex flex-col gap-1" data-testid="apply-fixes-result-warnings">
          <p className="text-sm font-medium text-amber-800">Warnings ({warnings.length})</p>
          <ul className="flex flex-col gap-1 text-xs text-amber-800">
            {warnings.map((w, i) => (
              <li key={i} className="rounded border border-amber-300 bg-amber-50 px-2 py-1">
                {w}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <Dialog.Footer>
        <Button
          variant="secondary"
          onClick={() => void copyToClipboard(formatFixResultText(result))}
          data-testid="apply-fixes-copy"
        >
          Copy
        </Button>
        <Button onClick={onClose} data-testid="apply-fixes-close">
          Close
        </Button>
      </Dialog.Footer>
    </div>
  );
}

function ErrorBody({ error, onClose }: { error: unknown; onClose: () => void }) {
  const { code, message } = toFixError(error);
  return (
    <div className="flex flex-col gap-3" data-testid="apply-fixes-result-error">
      <div className="flex flex-col gap-1 rounded border border-kd-danger-br bg-kd-danger-tint px-3 py-2">
        <p className="text-sm font-medium text-kd-danger-fg" data-testid="apply-fixes-error-code">
          {code}
        </p>
        <p className="text-sm text-kd-danger-fg" data-testid="apply-fixes-error-message">
          {message}
        </p>
      </div>
      <Dialog.Footer>
        <Button
          variant="secondary"
          onClick={() => void copyToClipboard(formatFixErrorText(error))}
          data-testid="apply-fixes-copy"
        >
          Copy
        </Button>
        <Button onClick={onClose} data-testid="apply-fixes-close">
          Close
        </Button>
      </Dialog.Footer>
    </div>
  );
}
