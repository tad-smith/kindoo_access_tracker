// The active stake's IANA timezone, for surfaces that need stake-local
// dates without otherwise caring about the stake doc.
//
// `useFirestoreDoc` keys its cache on the doc path, so pages that
// already subscribe to the stake doc share this listener rather than
// opening a second one. Returns `undefined` while the snapshot is in
// flight or when the field is unset; every consumer in `datetime.ts`
// falls back to `America/Denver` on `undefined`.

import { useMemo } from 'react';
import { useFirestoreDoc } from './data';
import { stakeRef } from './docs';
import { db } from './firebase';
import { useActiveStake } from './useActiveStake';

export function useStakeTimezone(): string | undefined {
  const activeStakeId = useActiveStake();
  const ref = useMemo(() => (activeStakeId ? stakeRef(db, activeStakeId) : null), [activeStakeId]);
  return useFirestoreDoc(ref).data?.timezone;
}
