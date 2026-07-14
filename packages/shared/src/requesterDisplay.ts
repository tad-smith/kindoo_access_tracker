// Derive a request's requester identity (name + calling) for display,
// live from the requester's `access` doc — nothing is captured on the
// request at submit time (Option A, live-derive). Shared by the web
// manager Queue and the Chrome extension panel so both render the
// requester line identically.
//
// `calling` prefers the sync-managed `importer_callings[scope]` (the
// calling-based app-access set). When a requester's access for the scope
// comes only from manager-granted `manual_grants`, we fall back to those
// grants' free-text `reason`s. When neither exists, `calling` is null and
// the label degrades to just the name (or the email when no name).
//
// Pure (no DOM, no Firestore) so it is unit-testable and runs in both the
// web SPA and the extension.

import type { Access } from './types/access.js';

/** Derived requester identity for the manager queue's "Requester:" line. */
export interface RequesterDisplay {
  /** Trimmed `member_name`, or null when unknown. */
  name: string | null;
  /**
   * Callings (or manual-grant reasons) that grant the requester access
   * for the request's scope, joined by ", "; null when none are known.
   */
  calling: string | null;
}

/** Trim a possibly-absent string; empty / whitespace-only → null. */
function trimmedOrNull(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Derive the requester's display name + calling from their `access` doc
 * for the request's scope.
 *
 *   - name    = trimmed `member_name`, or null.
 *   - calling = `importer_callings[scope]` (trimmed, non-empty) joined by
 *               ", "; failing that, `manual_grants[scope][].reason`
 *               (trimmed, non-empty) joined by ", "; failing that, null.
 *
 * A null / undefined `access` (doc absent or still loading) yields all
 * nulls, which `formatRequesterLabel` renders as the email fallback.
 */
export function deriveRequesterDisplay(
  access: Access | null | undefined,
  scope: string,
): RequesterDisplay {
  if (!access) return { name: null, calling: null };

  const name = trimmedOrNull(access.member_name);

  const callings = (access.importer_callings[scope] ?? [])
    .map(trimmedOrNull)
    .filter((c): c is string => c !== null);
  if (callings.length > 0) return { name, calling: callings.join(', ') };

  const reasons = (access.manual_grants[scope] ?? [])
    .map((grant) => trimmedOrNull(grant.reason))
    .filter((r): r is string => r !== null);
  if (reasons.length > 0) return { name, calling: reasons.join(', ') };

  return { name, calling: null };
}

/**
 * Format the final "Requester:" label. Falls back to the email when no
 * name is known; appends the calling in parentheses when present.
 */
export function formatRequesterLabel(display: RequesterDisplay, fallbackEmail: string): string {
  if (!display.name) return fallbackEmail;
  if (display.calling) return `${display.name} (${display.calling})`;
  return display.name;
}
