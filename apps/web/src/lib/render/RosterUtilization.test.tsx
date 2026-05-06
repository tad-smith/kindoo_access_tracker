// Component tests for `<RosterUtilization />` — the dual committed +
// pending bar pair used by the bishopric / stake roster pages.

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RosterUtilization } from './RosterUtilization';

function bars(): HTMLElement[] {
  return Array.from(document.querySelectorAll('.utilization')) as HTMLElement[];
}

function fills(): HTMLElement[] {
  return Array.from(document.querySelectorAll('.utilization-fill')) as HTMLElement[];
}

describe('<RosterUtilization />', () => {
  it('renders two stacked bars — committed first, pending second', () => {
    render(<RosterUtilization committedTotal={10} cap={25} pendingAdds={0} pendingRemoves={0} />);
    const all = bars();
    expect(all).toHaveLength(2);
    expect(all[0]?.className).toContain('layout-inline');
    expect(all[1]?.className).toContain('layout-inline');
  });

  it('places both rows inside one shared grid wrapper so the bars line up at the same width', () => {
    // The bar-width-match guarantee comes from the wrapper's CSS
    // grid (`grid-template-columns: 1fr auto`) plus each inner
    // `<UtilizationBar layout='inline'>` using `display: contents` so
    // its bar + label participate in the grid directly. jsdom does
    // not evaluate stylesheets, so we assert the structural contract
    // that the CSS keys off:
    //   - one `.kd-roster-utilization` wrapper
    //   - exactly two direct `.utilization.layout-inline` children
    //   - asymmetric label widths still yield exactly two bars + two
    //     labels at the wrapper level (the bars share the same column
    //     track via `display: contents`).
    const { container } = render(
      <RosterUtilization committedTotal={10} cap={25} pendingAdds={3} pendingRemoves={1} />,
    );
    const wrapper = container.querySelector('.kd-roster-utilization');
    expect(wrapper).not.toBeNull();
    const innerWrappers = Array.from(
      wrapper?.querySelectorAll(':scope > .utilization') ?? [],
    ) as HTMLElement[];
    expect(innerWrappers).toHaveLength(2);
    for (const inner of innerWrappers) {
      expect(inner.className).toContain('layout-inline');
    }
    expect(wrapper?.querySelectorAll('.utilization-bar').length).toBe(2);
    expect(wrapper?.querySelectorAll('.utilization-label').length).toBe(2);
  });

  it('labels the committed bar with "seats used" and the pending bar with "seats pending"', () => {
    render(<RosterUtilization committedTotal={10} cap={25} pendingAdds={0} pendingRemoves={0} />);
    expect(screen.getByText(/10 \/ 25 seats used/)).toBeInTheDocument();
    expect(screen.getByText(/10 \/ 25 seats pending/)).toBeInTheDocument();
  });

  it('projects pending = committed + adds - removes', () => {
    render(<RosterUtilization committedTotal={10} cap={25} pendingAdds={3} pendingRemoves={1} />);
    expect(screen.getByText(/10 \/ 25 seats used/)).toBeInTheDocument();
    expect(screen.getByText(/12 \/ 25 seats pending/)).toBeInTheDocument();
  });

  it('clamps the projected pending count to zero when removes outnumber committed + adds', () => {
    render(<RosterUtilization committedTotal={2} cap={25} pendingAdds={0} pendingRemoves={5} />);
    expect(screen.getByText(/0 \/ 25 seats pending/)).toBeInTheDocument();
  });

  describe('color signal on the pending bar', () => {
    it('matches the committed bar color when projected === committed (no net change)', () => {
      // committed=10, pendingAdds=2, pendingRemoves=2 → projected=10.
      // No net change → same fill class on both bars.
      render(<RosterUtilization committedTotal={10} cap={25} pendingAdds={2} pendingRemoves={2} />);
      const [committedFill, pendingFill] = fills();
      expect(pendingFill?.className).toBe(committedFill?.className);
    });

    it('matches the committed bar color when there are no pending requests at all', () => {
      render(<RosterUtilization committedTotal={10} cap={25} pendingAdds={0} pendingRemoves={0} />);
      const [committedFill, pendingFill] = fills();
      expect(pendingFill?.className).toBe(committedFill?.className);
      // And neither side carries the warning amber.
      expect(pendingFill?.className).not.toContain('near');
    });

    it('forces amber when projected > committed (net add)', () => {
      render(<RosterUtilization committedTotal={5} cap={25} pendingAdds={3} pendingRemoves={0} />);
      const [committedFill, pendingFill] = fills();
      // Committed at 5/25 = 20% → not near.
      expect(committedFill?.className).not.toContain('near');
      // Pending forced to amber via the difference signal.
      expect(pendingFill?.className).toContain('near');
    });

    it('forces amber when projected < committed (net remove)', () => {
      render(<RosterUtilization committedTotal={10} cap={25} pendingAdds={0} pendingRemoves={4} />);
      const [committedFill, pendingFill] = fills();
      expect(committedFill?.className).not.toContain('near');
      expect(pendingFill?.className).toContain('near');
    });

    it('keeps red OVER CAP on the pending bar even when there is a net difference', () => {
      // Difference signal would force amber, but over-cap red wins.
      render(
        <RosterUtilization
          committedTotal={20}
          cap={25}
          pendingAdds={10}
          pendingRemoves={0}
          committedOverCap={false}
        />,
      );
      const [committedFill, pendingFill] = fills();
      expect(committedFill?.className).not.toContain('over');
      expect(pendingFill?.className).toContain('over');
      expect(pendingFill?.className).not.toContain('near');
    });
  });

  it('shows a 100%-filled red pending bar with OVER CAP when projection exceeds cap', () => {
    render(
      <RosterUtilization
        committedTotal={20}
        cap={25}
        pendingAdds={10}
        pendingRemoves={0}
        committedOverCap={false}
      />,
    );
    // 30 / 25 = projection.
    expect(screen.getByText(/30 \/ 25 seats pending/)).toBeInTheDocument();
    expect(fills()[1]?.className).toContain('over');
    expect(screen.getAllByText(/OVER CAP/)).toHaveLength(1);
  });

  it('threads committedOverCap through to the committed bar without affecting the pending bar', () => {
    render(
      <RosterUtilization
        committedTotal={30}
        cap={25}
        pendingAdds={0}
        pendingRemoves={5}
        committedOverCap
      />,
    );
    const [committedFill, pendingFill] = fills();
    expect(committedFill?.className).toContain('over');
    // Pending = 25 → exactly cap → no over (and no near override yet
    // because we still apply the difference signal: 30 → 25 IS a net
    // change so amber wins for the under-cap case).
    expect(pendingFill?.className).not.toContain('over');
    expect(pendingFill?.className).toContain('near');
  });

  it('renders both rows in cap-unset form when cap is null', () => {
    const { container } = render(
      <RosterUtilization committedTotal={3} cap={null} pendingAdds={2} pendingRemoves={0} />,
    );
    expect(screen.getAllByText(/cap unset/i)).toHaveLength(2);
    // No bars rendered without a cap.
    expect(container.querySelectorAll('.utilization-bar')).toHaveLength(0);
  });
});
