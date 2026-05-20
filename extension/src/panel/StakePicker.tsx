// Stake picker — full-takeover gate rendered when the active Kindoo
// EID resolves to more than one stake the operator manages.
//
// The choice is one-shot per (EID, profile). The picker writes
// `STORAGE_KEYS.eidStakeChoice` (a `Record<eidString, stakeId>`) so the
// next panel open against the same EID short-circuits. On sign-out the
// SW wipes the key alongside `principalSnapshot`.
//
// No persistent switcher in the slide-over UI — the panel's context is
// the active Kindoo session's single EID, and changing the picked stake
// is something the operator does by signing out + back in, or by
// switching to a different Kindoo site whose EID resolves elsewhere.

import { useCallback, useState } from 'react';
import type { EidStakeCandidate } from '../lib/extensionApi';

interface StakePickerProps {
  email: string | null | undefined;
  eid: number;
  candidates: EidStakeCandidate[];
  /** Called when the operator confirms a choice — App persists it and
   * re-runs the active-stake resolution. Rejections (chrome.storage
   * write failure, quota exhausted, etc.) surface as an inline error
   * banner above the buttons; the picker stays clickable. */
  onPick: (stakeId: string) => Promise<void> | void;
}

export function StakePicker({ email, eid, candidates, onPick }: StakePickerProps) {
  const [pending, setPending] = useState<string | null>(null);
  const [writeError, setWriteError] = useState<string | null>(null);

  const handle = useCallback(
    async (stakeId: string) => {
      if (pending !== null) return;
      setPending(stakeId);
      setWriteError(null);
      try {
        await onPick(stakeId);
        // Resolution happens via App.tsx state — picker unmounts when
        // the choice persists, so no success path runs here.
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setWriteError(message);
      } finally {
        setPending(null);
      }
    },
    [onPick, pending],
  );

  return (
    <main className="sba-panel" data-testid="sba-stake-picker">
      <header className="sba-header">
        <h1>Choose a stake</h1>
      </header>
      <div className="sba-body">
        {email ? (
          <p className="sba-muted" data-testid="sba-stake-picker-email">
            Signed in as {email}
          </p>
        ) : null}
        <p>
          This Kindoo site (EID <strong data-testid="sba-stake-picker-eid">{eid}</strong>) is
          configured under more than one stake you manage. Pick the stake whose pending requests you
          want to work on. The choice sticks for this Kindoo site until you sign out.
        </p>
        {writeError !== null ? (
          <p role="alert" className="sba-error" data-testid="sba-stake-picker-write-error">
            Couldn&rsquo;t save your choice — try again.
          </p>
        ) : null}
        <ul className="sba-stake-picker-list" data-testid="sba-stake-picker-list">
          {candidates.map((c) => (
            <li key={c.stakeId}>
              <button
                type="button"
                className="sba-btn sba-btn-primary sba-stake-picker-btn"
                onClick={() => {
                  void handle(c.stakeId);
                }}
                disabled={pending !== null}
                data-testid={`sba-stake-picker-${c.stakeId}`}
              >
                <span className="sba-stake-picker-label">{c.label}</span>
                <span className="sba-stake-picker-match sba-muted">
                  {c.match === 'home' ? '(home site)' : `(foreign site: ${c.siteLabel ?? '?'})`}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </main>
  );
}
