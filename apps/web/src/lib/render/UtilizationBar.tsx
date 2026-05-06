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
// Layout variants:
//   - 'stacked' (default) — label above bar, used by the Dashboard and
//     All Seats utilization rows where a vertical stack reads best.
//   - 'inline' — bar takes the available row width and the label sits
//     to the right of it. Used by the roster pages where two bars
//     (committed + pending) stack and right-aligned labels keep the
//     denominator legible.
//
// `verb` swaps the trailing word in the label ("used" vs "pending") so
// the same component renders both bars on the roster pages without
// the caller piecing together a custom label.
//
// `tone='muted'` selects the desaturated fill used when a secondary
// bar should read as ancillary next to a primary one.
//
// `accent='warn'` overrides the ratio-driven fill choice and forces
// the amber `near` palette regardless of how full the bar is. Used by
// `<RosterUtilization>` to signal a net-pending difference on the
// projected bar even when the projection is well under cap (e.g.
// committed=2, pending=4 — the bar at 16% needs to read as "this
// will change" without waiting until it's near cap to amber).

import './UtilizationBar.css';

export type UtilizationBarLayout = 'stacked' | 'inline';
export type UtilizationBarVerb = 'used' | 'pending';
export type UtilizationBarTone = 'primary' | 'muted';
export type UtilizationBarAccent = 'auto' | 'warn';

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
  /** Layout variant; defaults to 'stacked' for back-compat. */
  layout?: UtilizationBarLayout;
  /** Trailing label verb; defaults to 'used'. */
  verb?: UtilizationBarVerb;
  /** Visual tone; defaults to 'primary'. */
  tone?: UtilizationBarTone;
  /**
   * Color override. `'auto'` (default) lets the ratio decide (blue /
   * amber / red). `'warn'` forces amber regardless of ratio, used to
   * signal a pending difference. `overCap === true` still wins —
   * red over-cap stays the priority signal.
   */
  accent?: UtilizationBarAccent;
}

export function UtilizationBar({
  total,
  cap,
  overCap = false,
  layout = 'stacked',
  verb = 'used',
  tone = 'primary',
  accent = 'auto',
}: UtilizationBarProps) {
  const safeTotal = Number.isFinite(total) ? Math.max(0, Math.trunc(total)) : 0;
  const hasCap = typeof cap === 'number' && Number.isFinite(cap) && cap > 0;

  const wrapperClass = `utilization layout-${layout}${tone === 'muted' ? ' tone-muted' : ''}`;

  if (!hasCap) {
    const seatsLabel = `${safeTotal} seat${safeTotal === 1 ? '' : 's'}`;
    // Cap-unset has no bar to put the label beside. In the inline
    // variant the wrapper uses `display: contents`, so emit a
    // single label that spans both grid columns; otherwise stack as
    // normal.
    if (layout === 'inline') {
      return (
        <div className={wrapperClass}>
          <div className="utilization-label utilization-label-span">
            <span>{seatsLabel}</span>
            <span>(cap unset)</span>
          </div>
        </div>
      );
    }
    return (
      <div className={wrapperClass}>
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
    : accent === 'warn' || ratio >= 0.9
      ? 'utilization-fill near'
      : 'utilization-fill';

  const labelText = `${safeTotal} / ${safeCap} seats ${verb}`;
  const overCapFlag = overCap ? <span className="over-cap-flag">OVER CAP</span> : null;
  const bar = (
    <div className="utilization-bar">
      <div className={fillClass} style={{ width: `${pct}%` }} />
    </div>
  );

  if (layout === 'inline') {
    // Bar grows to fill; label sits on the right at a fixed column so
    // stacked instances align their numerators.
    return (
      <div className={wrapperClass}>
        {bar}
        <div className="utilization-label">
          <span>{labelText}</span>
          {overCapFlag}
        </div>
      </div>
    );
  }

  return (
    <div className={wrapperClass}>
      <div className="utilization-label">
        <span>{labelText}</span>
        {overCapFlag}
      </div>
      {bar}
    </div>
  );
}
