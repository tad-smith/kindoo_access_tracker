// Two stacked utilization bars used by the roster pages (bishopric
// Roster, stake Roster, stake WardRosters):
//
//   1. Committed bar — `committedTotal / cap seats used`. Reflects
//      what the ward / stake actually has assigned right now.
//   2. Pending bar — `committedTotal + pendingAdds - pendingRemoves
//      / cap seats pending`. Projects what utilization will look like
//      after every in-flight request resolves.
//
// Both bars share the same `cap` denominator and the same row layout
// (`<UtilizationBar layout='inline'>`) so the labels right-align under
// each other and the bar widths line up vertically.
//
// The pending bar uses `tone='muted'` so it reads as ancillary
// information next to the primary committed bar. `verb='pending'`
// swaps the trailing word in the label.
//
// Pending count is clamped to >= 0 (a roster with more pending removes
// than committed seats — the importer-resync edge — would otherwise
// project a nonsense negative). The cap-overage signal (`overCap`) is
// passed through whenever the projected total exceeds the cap so the
// red fill + OVER CAP badge fires on the pending row independently of
// the committed row.

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
  return (
    <div className="kd-roster-utilization">
      <UtilizationBar
        total={committedTotal}
        cap={cap}
        overCap={committedOverCap}
        layout="inline"
        verb="used"
      />
      <UtilizationBar
        total={projected}
        cap={cap}
        overCap={projectedOverCap}
        layout="inline"
        verb="pending"
        tone="muted"
      />
    </div>
  );
}
