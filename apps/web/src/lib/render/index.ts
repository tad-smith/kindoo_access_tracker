// Render-helpers barrel. Phase 4 deliverable per the migration plan —
// every render utility ported from Apps Script's `ClientUtils.html`.
// Page code imports from here, never from individual files, so the
// public surface stays one place.

export { escapeHtml } from './escapeHtml';
export { formatDate, formatDateTime } from './formatDate';
export { UtilizationBar, type UtilizationBarProps } from './UtilizationBar';
export { EmptyState, type EmptyStateProps } from './EmptyState';
export { LoadingSpinner, type LoadingSpinnerProps } from './LoadingSpinner';
