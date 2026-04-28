// Utilization bar — React port of `renderUtilizationBar` from the Apps
// Script `ClientUtils.html`. Used by the manager dashboard cards, the
// roster summary cards, and the All Seats total bar.
//
// Behavioural contract (mirrors the Apps Script helper):
//   - cap absent / non-positive → render the count alone with a
//     "(cap unset)" qualifier; no progress bar.
//   - cap present, total / cap < 0.9 → "blue" fill (the brand primary).
//   - cap present, total / cap >= 0.9 (and not over) → "amber" fill.
//   - cap present, over_cap === true → "red" fill + an "OVER CAP" badge.
//
// The `over_cap` flag is computed server-side per the spec — total may
// equal cap exactly without tripping over_cap. Don't recompute here.
//
// Visual classes are kept verbatim (`utilization`, `utilization-bar`,
// `utilization-fill`, `near`, `over`, `over-cap-flag`) so the ported
// CSS in `apps/web/src/styles/` produces pixel-equivalent output to
// the Apps Script app.

import './UtilizationBar.css';

export interface UtilizationBarProps {
  /** Total seats currently occupying the pool. */
  total: number;
  /** Pool capacity. `null`/`undefined` renders the cap-unset variant. */
  cap: number | null | undefined;
  /**
   * Server-set "we already passed cap, regardless of how the bar fill
   * rounds." Trust this flag — don't re-derive `total > cap` here.
   */
  overCap?: boolean;
}

export function UtilizationBar({ total, cap, overCap = false }: UtilizationBarProps) {
  const safeTotal = Number.isFinite(total) ? Math.max(0, Math.trunc(total)) : 0;
  const hasCap = typeof cap === 'number' && Number.isFinite(cap) && cap > 0;

  if (!hasCap) {
    const seatsLabel = `${safeTotal} seat${safeTotal === 1 ? '' : 's'}`;
    return (
      <div className="utilization">
        <div className="utilization-label">
          <span>{seatsLabel}</span>
          <span>(cap unset)</span>
        </div>
      </div>
    );
  }

  const safeCap = cap;
  const ratio = safeTotal / safeCap;
  const pct = Math.min(100, Math.round(ratio * 100));
  const fillClass = overCap
    ? 'utilization-fill over'
    : ratio >= 0.9
      ? 'utilization-fill near'
      : 'utilization-fill';

  return (
    <div className="utilization">
      <div className="utilization-label">
        <span>
          {safeTotal} / {safeCap} seats used
        </span>
        {overCap ? <span className="over-cap-flag">OVER CAP</span> : null}
      </div>
      <div className="utilization-bar">
        <div className={fillClass} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
