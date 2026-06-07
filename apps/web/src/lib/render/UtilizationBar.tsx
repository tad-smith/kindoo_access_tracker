// Utilization bar. Used by the manager dashboard cards, the roster
// summary cards, and the All Seats total bar.
//
// Behavioural contract:
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
//     `name` is not used here.
//   - 'inline' — a three-cell row: an optional leading NAME cell, the
//     bar in the middle, and the count label on the right. Used by the
//     roster pages where several bars (committed + pending + per-org)
//     stack inside a shared grid so the bar fill column lines up across
//     every row regardless of name / count length.
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
  /**
   * Optional leading name (e.g. "Stake Total" or an organization name)
   * rendered in a LEFT cell, to the left of the bar. Used by
   * `<RosterUtilization>` to label the "Stake Total" bar and the
   * per-organization bars below it. Inline layout only; the name lives
   * in its own grid cell (NOT inside the count label), so the shared
   * grid keeps every bar's fill column at an identical width regardless
   * of name / count length. Requires `withNameColumn` to render.
   */
  name?: string;
  /**
   * Inline layout only. When true, the bar emits a LEFT name cell (the
   * `name`, or blank for an unnamed row like the pending bar) so a
   * shared three-column grid (`name | bar | count`) stays aligned across
   * rows. When false (the default), NO name cell is emitted — the bar is
   * just `bar | count`, identical to the pre-org two-column layout, so
   * non-org rosters (bishopric / ward, stake with no orgs) carry no
   * empty name track and no extra `column-gap` left-shift.
   */
  withNameColumn?: boolean;
}

export function UtilizationBar({
  total,
  cap,
  overCap = false,
  layout = 'stacked',
  verb = 'used',
  tone = 'primary',
  accent = 'auto',
  name,
  withNameColumn = false,
}: UtilizationBarProps) {
  const safeTotal = Number.isFinite(total) ? Math.max(0, Math.trunc(total)) : 0;
  const hasCap = typeof cap === 'number' && Number.isFinite(cap) && cap > 0;

  const wrapperClass = `utilization layout-${layout}${tone === 'muted' ? ' tone-muted' : ''}`;

  // Inline-only LEFT name cell. Emitted only when `withNameColumn` is on
  // (org rosters), so the shared three-column grid's `name` track is
  // populated on every row (blank for unnamed rows like the pending
  // bar). Without it, no name cell is emitted and the row is a plain
  // `bar | count` — no empty track, no `column-gap` left-shift on
  // non-org rosters.
  const nameCell =
    layout === 'inline' && withNameColumn ? (
      <span className="utilization-name">{name ?? ''}</span>
    ) : null;

  if (!hasCap) {
    const seatsLabel = `${safeTotal} seat${safeTotal === 1 ? '' : 's'}`;
    // Cap-unset has no bar to put the count beside. In the inline
    // variant the wrapper uses `display: contents`, so emit the name
    // cell plus a label that spans the remaining grid columns;
    // otherwise stack as normal.
    if (layout === 'inline') {
      // The count label spans the bar + count columns. With a name
      // column it starts at col 2 (after the name); without one the
      // grid is two columns, so it spans the whole row.
      const spanClass = withNameColumn
        ? 'utilization-label utilization-label-span utilization-label-span--after-name'
        : 'utilization-label utilization-label-span';
      return (
        <div className={wrapperClass}>
          {nameCell}
          <div className={spanClass}>
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
    // Three cells promoted into the shared grid via `display: contents`:
    // name on the left, bar in the middle, count on the right. The name
    // cell collapses when empty, so unnamed bars read `[bar] count`.
    return (
      <div className={wrapperClass}>
        {nameCell}
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
