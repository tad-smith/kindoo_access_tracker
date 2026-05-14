// Two stacked utilization bars used by the roster pages (bishopric
// Roster, stake Roster, stake WardRosters):
//
//   1. Committed bar — `committedTotal / cap seats used`. Reflects
//      what the ward / stake actually has assigned right now.
//   2. Pending bar — `committedTotal + pendingAdds - pendingRemoves
//      / cap seats pending`. Projects what utilization will look like
//      after every in-flight request resolves.
//
// Pending bar renders only when there are in-flight pending requests
// for the scope (`pendingAdds > 0 || pendingRemoves > 0`); absent any,
// only the committed bar shows so the widget doesn't duplicate the
// same number twice.
//
// Both bars sit inside a CSS grid (`grid-template-columns: 1fr auto`)
// declared on the wrapper so the bar column resolves to the SAME width
// across both rows regardless of label-text length. Without the shared
// grid the bars would size independently (different label widths →
// different remaining flex space), which the operator caught as a
// visual misalignment in PR review.
//
// Color signal on the pending bar:
//   - projected === committedTotal → no net change; pending bar uses
//     the same color as the committed bar (the auto ratio rule).
//   - projected !== committedTotal → there is a net pending difference
//     in either direction; pending bar forces amber (`accent='warn'`)
//     to flag "this WILL change."
//   - projected > cap                → red OVER CAP still wins, since
//     the over-cap signal is the strongest one and the user needs to
//     see it independently of the difference signal.
//
// Pending count is clamped to >= 0 (a roster with more pending removes
// than committed seats — the importer-resync edge — would otherwise
// project a nonsense negative).

import { UtilizationBar } from './UtilizationBar';

export interface RosterUtilizationProps {
  /** Currently committed seats in the displayed scope. */
  committedTotal: number;
  /** Pool capacity. `null`/`undefined` renders cap-unset on both rows. */
  cap: number | null | undefined;
  /** Pending `add_*` requests for the displayed scope. */
  pendingAdds: number;
  /** Pending `remove` requests for the displayed scope. */
  pendingRemoves: number;
  /** Pre-computed committed-row over-cap flag (paths already track this). */
  committedOverCap?: boolean;
}

export function RosterUtilization({
  committedTotal,
  cap,
  pendingAdds,
  pendingRemoves,
  committedOverCap = false,
}: RosterUtilizationProps) {
  const projected = Math.max(0, committedTotal + pendingAdds - pendingRemoves);
  const projectedOverCap = typeof cap === 'number' && cap > 0 && projected > cap;
  const hasNetChange = projected !== committedTotal;
  const hasPending = pendingAdds > 0 || pendingRemoves > 0;
  return (
    <div className="kd-roster-utilization">
      <UtilizationBar
        total={committedTotal}
        cap={cap}
        overCap={committedOverCap}
        layout="inline"
        verb="used"
      />
      {hasPending ? (
        <UtilizationBar
          total={projected}
          cap={cap}
          overCap={projectedOverCap}
          layout="inline"
          verb="pending"
          accent={hasNetChange ? 'warn' : 'auto'}
        />
      ) : null}
    </div>
  );
}
