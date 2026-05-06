// Pure partitioner used by the bishopric / stake roster pages to
// surface in-flight requests against the displayed scope.
//
// Two outputs collapse the full pending-request stream into the two
// shapes a roster page needs:
//
//   - `pendingAdds`     — every pending `add_manual` / `add_temp`
//                         request for the scope. Renders as a new
//                         "Outstanding Requests" section below the
//                         roster.
//   - `pendingRemovesByCanonical`
//                       — every pending `remove` request for the
//                         scope, keyed by the subject member's
//                         canonical email so the roster card lookup
//                         is O(1) per row. The matching seat row
//                         picks up an inline "Pending Removal"
//                         badge + light-pink background.
//
// Pure — caller passes the already-scoped slice (the live hook
// filters by `scope`); we re-filter defensively in case the caller
// forwards an unfiltered list (e.g. from a future hook variant).
//
// Sort: `pendingAdds` retains the order the caller supplied. The
// live hook orders by `requested_at` ascending (FIFO), matching the
// manager Queue page so the visual order stays consistent.

import type { AccessRequest } from '@kindoo/shared';

export interface RosterPendingPartition {
  pendingAdds: AccessRequest[];
  pendingRemovesByCanonical: Map<string, AccessRequest>;
}

export function partitionPendingForRoster(
  requests: readonly AccessRequest[],
  scope: string,
): RosterPendingPartition {
  const pendingAdds: AccessRequest[] = [];
  const pendingRemovesByCanonical = new Map<string, AccessRequest>();
  for (const r of requests) {
    if (r.scope !== scope) continue;
    if (r.status !== 'pending') continue;
    if (r.type === 'remove') {
      // First-seen wins — the manager Queue resolves the FIFO oldest
      // first, so the oldest pending remove for a given member is
      // what the badge represents.
      if (!pendingRemovesByCanonical.has(r.member_canonical)) {
        pendingRemovesByCanonical.set(r.member_canonical, r);
      }
      continue;
    }
    if (r.type === 'add_manual' || r.type === 'add_temp') {
      pendingAdds.push(r);
    }
  }
  return { pendingAdds, pendingRemovesByCanonical };
}
