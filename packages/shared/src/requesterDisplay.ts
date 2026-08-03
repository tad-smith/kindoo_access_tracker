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
// Kindoo Managers may submit a request in any scope without holding an
// `access` row, so an optional `manager` doc backstops both fields: it
// supplies the name when `access` has none, and the literal calling
// "Kindoo Manager" when no calling resolves for the scope. The `access`
// doc wins on each field independently. Only an ACTIVE manager doc
// contributes — inactive or absent leaves the access-only result intact.
//
// Pure (no DOM, no Firestore) so it is unit-testable and runs in both the
// web SPA and the extension.

import type { Access } from './types/access.js';
import type { KindooManager } from './types/kindooManager.js';

/** Calling shown for a manager-submitted request with no access-derived calling. */
const MANAGER_CALLING = 'Kindoo Manager';

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

/** The access-derived calling for `scope`, or null when none applies. */
function callingFromAccess(access: Access | null | undefined, scope: string): string | null {
  if (!access) return null;

  const callings = (access.importer_callings[scope] ?? [])
    .map(trimmedOrNull)
    .filter((c): c is string => c !== null);
  if (callings.length > 0) return callings.join(', ');

  const reasons = (access.manual_grants[scope] ?? [])
    .map((grant) => trimmedOrNull(grant.reason))
    .filter((r): r is string => r !== null);
  if (reasons.length > 0) return reasons.join(', ');

  return null;
}

/**
 * Derive the requester's display name + calling for the request's scope.
 * Name and calling resolve independently; `access` wins on both.
 *
 *   - name    = trimmed `access.member_name`; failing that, the active
 *               `manager` doc's trimmed `name`; failing that, null.
 *   - calling = `importer_callings[scope]` (trimmed, non-empty) joined by
 *               ", "; failing that, `manual_grants[scope][].reason`
 *               (trimmed, non-empty) joined by ", "; failing that,
 *               "Kindoo Manager" when an active `manager` doc was passed;
 *               failing that, null.
 *
 * `manager` is optional: omitting it, passing null/undefined, or passing a
 * doc with `active !== true` reproduces the access-only result exactly.
 * All-nulls is what `formatRequesterLabel` renders as the email fallback.
 */
export function deriveRequesterDisplay(
  access: Access | null | undefined,
  scope: string,
  manager?: KindooManager | null,
): RequesterDisplay {
  const activeManager = manager && manager.active === true ? manager : null;

  const name = trimmedOrNull(access?.member_name) ?? trimmedOrNull(activeManager?.name);
  const calling = callingFromAccess(access, scope) ?? (activeManager ? MANAGER_CALLING : null);

  return { name, calling };
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
