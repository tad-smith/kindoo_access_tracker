// New-request modal — opened by the page-header "New Request" button on
// the roster pages (bishopric Roster, stake Roster, stake Ward Rosters)
// via `NewRequestAffordance`. Mirrors `EditSeatDialog`: a controlled
// `<Dialog>` wrapping a react-hook-form `<form>` whose Cancel / Submit
// live in `Dialog.Footer` inside the form.
//
// Data (scopes / buildings / wards) comes from the shared
// `useNewRequestFormData` hook — the same hook the standalone `/new`
// page (`NewRequestPage`) consumes, so the dialog and page can never
// diverge. While the catalogue is loading the dialog renders a spinner
// in place of the form. The dialog is always launched from a scoped
// roster context, so it narrows the form's scope list to the single
// launched scope — the form then renders it as a fixed label (no
// picker), never the multi-scope dropdown. The `/new` page keeps the
// full list, so multi-scope users still get the dropdown there. Submit
// closes the dialog on success; Cancel closes without submitting. The
// dialog unmounts the form on close (fresh mount each open), so the
// form's post-submit reset is unnecessary in this path.

import { Dialog } from '../../../components/ui/Dialog';
import { LoadingSpinner } from '../../../lib/render/LoadingSpinner';
import { NewRequestForm } from './NewRequestForm';
import { useNewRequestFormData } from '../hooks';

export interface NewRequestDialogProps {
  /** Open / close handle from the parent affordance. */
  open: boolean;
  onOpenChange: (next: boolean) => void;
  /** Scope to pre-select (the roster page's scope). */
  scope?: string;
}

export function NewRequestDialog({ open, onOpenChange, scope }: NewRequestDialogProps) {
  const { scopes, buildings, wards, isLoading } = useNewRequestFormData();

  // Lock the form to the single launched scope: the form renders a
  // one-element scope list as a fixed label, never the dropdown. The
  // `only ? ... : scopes` fallback is defensive — the affordance only
  // opens the dialog when the viewer is authorized for `scope`, so the
  // match should always be found; falling back to the full list avoids
  // a broken dialog in the impossible case.
  const only = scopes.find((s) => s.value === scope);

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="New Request"
      description="Submit a manual or temporary access request."
    >
      {isLoading ? (
        <LoadingSpinner variant="block" />
      ) : (
        <NewRequestForm
          scopes={only ? [only] : scopes}
          buildings={buildings}
          wards={wards}
          {...(scope !== undefined ? { initialScope: scope } : {})}
          onSubmitted={() => onOpenChange(false)}
          onCancel={() => onOpenChange(false)}
        />
      )}
    </Dialog>
  );
}
