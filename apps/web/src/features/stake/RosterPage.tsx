// Stake Presidency Roster page (live). Mirrors
// `src/ui/stake/Roster.html`. Scope is hard-locked to `'stake'`; rules
// keep bishoprics out via the per-doc rule:
//   `(resource.data.scope == 'stake' && isStakeMember(stakeId))`.
//
// Phase 5 is read-only; the X / removal-pending affordance is a
// Phase-6 deliverable.

import { useFirestoreOnce } from '../../lib/data';
import { stakeRef } from '../../lib/docs';
import { db } from '../../lib/firebase';
import { STAKE_ID } from '../../lib/constants';
import { useStakeRoster } from './hooks';
import { RosterCardList } from '../../components/roster/RosterCardList';
import { UtilizationBar } from '../../lib/render/UtilizationBar';
import { LoadingSpinner } from '../../lib/render/LoadingSpinner';

export function StakeRosterPage() {
  const seats = useStakeRoster();
  const stakeDocResult = useFirestoreOnce(stakeRef(db, STAKE_ID));
  const stakeDoc = stakeDocResult.data;

  const seatCount = seats.data?.length ?? 0;
  // Stake-scope is one slice of the stake_seat_cap; the dashboard's
  // "stake portion" math is implemented in the manager dashboard's
  // utilization card. Here we just show the raw count vs the stake_seat_cap
  // headline figure so a stake president knows roughly where they stand.
  const cap = stakeDoc?.stake_seat_cap ?? null;

  return (
    <section>
      <h1>Stake Roster</h1>
      <p className="kd-page-subtitle">Stake</p>

      <div className="kd-utilization-host">
        <UtilizationBar total={seatCount} cap={cap} overCap={cap !== null && seatCount > cap} />
      </div>

      {seats.isLoading || seats.data === undefined ? (
        <LoadingSpinner />
      ) : (
        <RosterCardList
          seats={seats.data}
          emptyMessage="No stake seats yet. The next import seeds auto-seats from the LCR Stake tab; manual additions land via the New Kindoo Request page (Phase 6)."
        />
      )}
    </section>
  );
}
