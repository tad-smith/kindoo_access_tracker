// Stake-aware toast boundary. Subscribes to the active-stake
// invalidation event bus (`useActiveStakeInvalidation`) and fires the
// spec §2.1 toast with the new stake's DISPLAY NAME — not the slug —
// substituted into the message.
//
// Why this lives outside `useActiveStake.ts`: that hook is consumed
// by route-gate code paths (e.g., `useRequireRole`) that don't have a
// stake-doc subscription. They only know the slug. The boundary
// mounts once inside Shell, where `useFirestoreDoc(stakeRef(...))`
// IS already in play, so the substitution can read `stake_name` off
// the live doc.
//
// Renders nothing. Side-effect-only.

import { useEffect } from 'react';
import { useFirestoreDoc } from '../../lib/data';
import { stakeRef } from '../../lib/docs';
import { db } from '../../lib/firebase';
import { useActiveStakeInvalidation } from '../../lib/useActiveStake';
import { toast } from '../../lib/store/toast';
import type { Stake } from '@kindoo/shared';

// Module-scoped dedupe so a Shell unmount/remount cycle doesn't re-fire
// the toast for the same logical event. The active-stake invalidation
// stream is monotonically increasing per `useActiveStake`'s event id;
// once we've toasted for a given id, never toast for it again.
let lastFiredEventId: number | null = null;

/** Test-only reset. Restores the dedupe to its initial empty state. */
export function __resetActiveStakeToastBoundaryForTests(): void {
  lastFiredEventId = null;
}

export function ActiveStakeToastBoundary() {
  const event = useActiveStakeInvalidation();
  // Read the post-fall-through stake's display name. When the resolver
  // landed on `null` (zero-role superadmin with stale storage), pass a
  // null ref so the query is disabled.
  const newStakeRef = event && event.newStakeId !== null ? stakeRef(db, event.newStakeId) : null;
  const stakeDoc = useFirestoreDoc<Stake>(newStakeRef);
  const newStakeName = stakeDoc.data?.stake_name ?? null;

  useEffect(() => {
    if (event === null) return;
    if (lastFiredEventId === event.eventId) return;

    if (event.tier === 'url') {
      // URL-tier copy doesn't substitute the new stake's name.
      lastFiredEventId = event.eventId;
      toast('This notification was for a stake you no longer have access to.', 'warn');
      return;
    }

    // Storage-tier ('session' / 'local') case. The toast substitutes
    // the new stake's display name. When the resolver fell through to
    // null (zero-role superadmin with stale storage) the wording omits
    // the substitution entirely — fire immediately.
    if (event.newStakeId === null) {
      lastFiredEventId = event.eventId;
      toast('Your last-active stake is no longer available.', 'warn');
      return;
    }

    // Wait until the stake-doc subscription has either yielded data or
    // settled into a non-pending state. `stakeDoc.status === 'pending'`
    // means the listener is still on initial connect; we delay the
    // toast a tick so the display name has a chance to land. Once the
    // status settles, fire using `stake_name` if it's present and the
    // slug as a fallback.
    if (stakeDoc.status === 'pending') return;
    lastFiredEventId = event.eventId;
    const displayName = newStakeName ?? event.newStakeId;
    toast(`Your last-active stake is no longer available; switched to ${displayName}.`, 'warn');
  }, [event, newStakeName, stakeDoc.status]);

  return null;
}
