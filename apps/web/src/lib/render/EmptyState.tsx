// Cross-page "no rows" placeholder. Used by every roster / queue / log
// page that renders a list.

import type { ReactNode } from 'react';
import './EmptyState.css';

export interface EmptyStateProps {
  /** Visible message. Falls back to "Nothing to show." if omitted. */
  message?: string;
  /** Optional follow-up content (CTA link, secondary explanation). */
  children?: ReactNode;
}

export function EmptyState({ message, children }: EmptyStateProps) {
  return (
    <div className="roster-empty" role="status">
      <p>{message ?? 'Nothing to show.'}</p>
      {children}
    </div>
  );
}
