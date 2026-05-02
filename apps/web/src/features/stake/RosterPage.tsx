// Stake Presidency Roster page (live). Mirrors
// `src/ui/stake/Roster.html`. Scope is hard-locked to `'stake'`; rules
// keep bishoprics out via the per-doc rule:
//   `(resource.data.scope == 'stake' && isStakeMember(stakeId))`.

import { useMemo } from 'react';
import { useFirestoreDoc } from '../../lib/data';
import { stakeRef } from '../../lib/docs';
import { db } from '../../lib/firebase';
import { STAKE_ID } from '../../lib/constants';
import { useStakeRoster, useStakeWards } from './hooks';
import { RosterCardList } from '../../components/roster/RosterCardList';
import { sortSeatsWithinScope } from '../../lib/sort/seats';
import { UtilizationBar } from '../../lib/render/UtilizationBar';
import { stakeAvailablePoolSize } from '../../lib/render/stakePool';
import { LoadingSpinner } from '../../lib/render/LoadingSpinner';
import { RemovalAffordance } from '../requests/components/RemovalAffordance';

export function StakeRosterPage() {
  const seats = useStakeRoster();
  const wards = useStakeWards();
  // Live subscription — `useFirestoreOnce` was reliably empty in
  // production for this page (TanStack cache miss + no listener to
  // populate it), so the cap fell through to the "(cap unset)" path.
  const stakeDocResult = useFirestoreDoc(stakeRef(db, STAKE_ID));
  const stakeDoc = stakeDocResult.data;

  const sortedSeats = useMemo(() => sortSeatsWithinScope(seats.data ?? []), [seats.data]);
  const seatCount = seats.data?.length ?? 0;
  // Stake-presidency pool size: stake_seat_cap minus what wards have
  // pre-allocated. The headroom the presidency actually owns. Same
  // denominator the Dashboard + AllSeats Stake-scope bars use.
  const cap = stakeAvailablePoolSize(stakeDoc?.stake_seat_cap, wards.data ?? []);

  return (
    <section>
      <h1>Stake Roster</h1>
      <p className="kd-page-subtitle">Stake</p>

      <div className="kd-utilization-host">
        <UtilizationBar
          total={seatCount}
          cap={cap}
          overCap={typeof cap === 'number' && cap > 0 && seatCount > cap}
        />
      </div>

      {seats.isLoading || seats.data === undefined ? (
        <LoadingSpinner />
      ) : (
        <RosterCardList
          seats={sortedSeats}
          emptyMessage="No stake seats yet. The next import seeds auto-seats from the LCR Stake tab; manual additions land via the New Kindoo Request page."
          actions={(seat) => (seat.type === 'auto' ? null : <RemovalAffordance seat={seat} />)}
        />
      )}
    </section>
  );
}
