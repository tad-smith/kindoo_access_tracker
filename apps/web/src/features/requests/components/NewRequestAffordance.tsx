// Page-header "New Request" affordance for roster pages (bishopric
// Roster, stake Roster, stake Ward Rosters). Mirrors
// `EditSeatAffordance`: renders the trigger button, holds local `open`
// state, and mounts the `NewRequestDialog` while open.
//
// Gating (request authority for the page's scope) stays on the page, so
// this component only renders the button + dialog. The `testId` keeps
// each page's distinct data-testid (`bishopric-roster-new-request`,
// etc.) so the E2E suite can disambiguate the three buttons.

import { useState } from 'react';
import { Button } from '../../../components/ui/Button';
import { NewRequestDialog } from './NewRequestDialog';

export interface NewRequestAffordanceProps {
  /** Scope to pre-select in the dialog's form (the page's scope). */
  scope: string;
  /** data-testid for the trigger button (per-page distinct id). */
  testId: string;
}

export function NewRequestAffordance({ scope, testId }: NewRequestAffordanceProps) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button variant="default" onClick={() => setOpen(true)} data-testid={testId}>
        New Request
      </Button>
      {open ? <NewRequestDialog open onOpenChange={(next) => setOpen(next)} scope={scope} /> : null}
    </>
  );
}
