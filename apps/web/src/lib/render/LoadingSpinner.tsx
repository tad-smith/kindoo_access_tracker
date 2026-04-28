// Cross-page loading affordance. Used by Suspense fallbacks (the root
// `<Suspense>` and per-page `<Suspense>` boundaries) and by manual
// "loading…" cells inside list rows.
//
// The Apps Script app didn't have a unified spinner — pages set
// `<div class="hidden">Loading…</div>` and toggled the class. The new
// SPA centralises on this component for parity with the spec's
// "every page surfaces a loading state" intent (`docs/spec.md` §5).

import './LoadingSpinner.css';

export interface LoadingSpinnerProps {
  /** Accessible label for the spinner. Defaults to "Loading…" */
  label?: string;
  /**
   * `inline` — sits inline with text (default).
   * `block`  — fills the available width with a centred spinner.
   */
  variant?: 'inline' | 'block';
}

export function LoadingSpinner({ label = 'Loading…', variant = 'inline' }: LoadingSpinnerProps) {
  return (
    <span
      className={`kd-spinner kd-spinner-${variant}`}
      role="status"
      aria-live="polite"
      aria-label={label}
    >
      <span className="kd-spinner-dot" aria-hidden="true" />
      <span className="kd-spinner-label">{label}</span>
    </span>
  );
}
