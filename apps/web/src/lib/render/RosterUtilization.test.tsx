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
  it('renders two stacked bars — committed first, pending second — when pending requests exist', () => {
    render(<RosterUtilization committedTotal={10} cap={25} pendingAdds={2} pendingRemoves={0} />);
    const all = bars();
    expect(all).toHaveLength(2);
    expect(all[0]?.className).toContain('layout-inline');
    expect(all[1]?.className).toContain('layout-inline');
  });

  it('renders only the committed bar when there are no pending requests', () => {
    render(<RosterUtilization committedTotal={10} cap={25} pendingAdds={0} pendingRemoves={0} />);
    const all = bars();
    expect(all).toHaveLength(1);
    expect(all[0]?.className).toContain('layout-inline');
    expect(screen.getByText(/10 \/ 25 seats used/)).toBeInTheDocument();
    expect(screen.queryByText(/seats pending/)).toBeNull();
  });

  it('renders both bars when only pendingAdds is non-zero', () => {
    render(<RosterUtilization committedTotal={10} cap={25} pendingAdds={3} pendingRemoves={0} />);
    expect(bars()).toHaveLength(2);
    expect(screen.getByText(/13 \/ 25 seats pending/)).toBeInTheDocument();
  });

  it('renders both bars when only pendingRemoves is non-zero', () => {
    render(<RosterUtilization committedTotal={10} cap={25} pendingAdds={0} pendingRemoves={2} />);
    expect(bars()).toHaveLength(2);
    expect(screen.getByText(/8 \/ 25 seats pending/)).toBeInTheDocument();
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
    render(<RosterUtilization committedTotal={10} cap={25} pendingAdds={1} pendingRemoves={1} />);
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

    it('omits the pending bar entirely when there are no pending requests at all', () => {
      render(<RosterUtilization committedTotal={10} cap={25} pendingAdds={0} pendingRemoves={0} />);
      const all = fills();
      expect(all).toHaveLength(1);
      // The single bar is the committed bar and carries no warning amber.
      expect(all[0]?.className).not.toContain('near');
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

  describe('per-organization bars', () => {
    it('relabels the committed bar "Stake Total" when org rows are present', () => {
      render(
        <RosterUtilization
          committedTotal={12}
          cap={25}
          pendingAdds={0}
          pendingRemoves={0}
          orgRows={[{ name: 'Stake Choir', total: 3, cap: 5 }]}
        />,
      );
      expect(screen.getByText(/Stake Total: 12 \/ 25 seats used/)).toBeInTheDocument();
    });

    it('leaves the committed bar unlabelled when there are no org rows', () => {
      render(
        <RosterUtilization
          committedTotal={12}
          cap={25}
          pendingAdds={0}
          pendingRemoves={0}
          orgRows={[]}
        />,
      );
      expect(screen.getByText(/^12 \/ 25 seats used$/)).toBeInTheDocument();
      expect(screen.queryByText(/Stake Total/)).toBeNull();
    });

    it('renders one bar per organization with its count and cap', () => {
      render(
        <RosterUtilization
          committedTotal={12}
          cap={25}
          pendingAdds={0}
          pendingRemoves={0}
          orgRows={[
            { name: 'Stake Choir', total: 3, cap: 5 },
            { name: 'Youth Program', total: 8, cap: 10 },
          ]}
        />,
      );
      expect(screen.getByText(/Stake Choir: 3 \/ 5 seats used/)).toBeInTheDocument();
      expect(screen.getByText(/Youth Program: 8 \/ 10 seats used/)).toBeInTheDocument();
      // Stake Total + 2 org bars = 3 bars (no pending).
      expect(fills()).toHaveLength(3);
    });

    it('renders an org bar with zero count', () => {
      render(
        <RosterUtilization
          committedTotal={5}
          cap={25}
          pendingAdds={0}
          pendingRemoves={0}
          orgRows={[{ name: 'Empty Org', total: 0, cap: 4 }]}
        />,
      );
      expect(screen.getByText(/Empty Org: 0 \/ 4 seats used/)).toBeInTheDocument();
    });

    it('shows the amber near signal on an org bar at >=90% of its cap', () => {
      render(
        <RosterUtilization
          committedTotal={20}
          cap={25}
          pendingAdds={0}
          pendingRemoves={0}
          orgRows={[{ name: 'Near Org', total: 9, cap: 10 }]}
        />,
      );
      // Last fill is the org bar (committed Stake Total bar is first).
      const orgFill = fills().at(-1);
      expect(orgFill?.className).toContain('near');
    });

    it('shows red OVER CAP on an org bar whose count exceeds its cap', () => {
      render(
        <RosterUtilization
          committedTotal={20}
          cap={25}
          pendingAdds={0}
          pendingRemoves={0}
          orgRows={[{ name: 'Over Org', total: 7, cap: 5 }]}
        />,
      );
      const orgFill = fills().at(-1);
      expect(orgFill?.className).toContain('over');
      expect(screen.getByText(/OVER CAP/)).toBeInTheDocument();
    });

    it('places the org bars inside the same shared grid wrapper as the stake bars', () => {
      const { container } = render(
        <RosterUtilization
          committedTotal={12}
          cap={25}
          pendingAdds={2}
          pendingRemoves={0}
          orgRows={[{ name: 'Stake Choir', total: 3, cap: 5 }]}
        />,
      );
      const wrapper = container.querySelector('.kd-roster-utilization');
      const inner = Array.from(
        wrapper?.querySelectorAll(':scope > .utilization') ?? [],
      ) as HTMLElement[];
      // Stake Total (committed) + pending + 1 org = 3 inline bars.
      expect(inner).toHaveLength(3);
      for (const el of inner) {
        expect(el.className).toContain('layout-inline');
      }
    });
  });
});
