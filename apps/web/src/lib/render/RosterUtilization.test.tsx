// Component tests for `<RosterUtilization />` — the dual committed +
// pending bar pair used by the bishopric / stake roster pages.

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RosterUtilization } from './RosterUtilization';

function bars(): HTMLElement[] {
  return Array.from(document.querySelectorAll('.utilization')) as HTMLElement[];
}

describe('<RosterUtilization />', () => {
  it('renders two stacked bars — committed first, pending second', () => {
    render(<RosterUtilization committedTotal={10} cap={25} pendingAdds={0} pendingRemoves={0} />);
    const all = bars();
    expect(all).toHaveLength(2);
    expect(all[0]?.className).toContain('layout-inline');
    expect(all[1]?.className).toContain('layout-inline');
    // Pending bar is the muted one.
    expect(all[0]?.className).not.toContain('tone-muted');
    expect(all[1]?.className).toContain('tone-muted');
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
    // The pending bar (second one) carries the over fill class.
    const fills = Array.from(document.querySelectorAll('.utilization-fill')) as HTMLElement[];
    expect(fills[1]?.className).toContain('over');
    // Only the pending row reports OVER CAP — the committed row stays
    // green when its own count is still under cap.
    expect(screen.getAllByText(/OVER CAP/)).toHaveLength(1);
  });

  it('does not over-flag the pending bar when projection equals the cap exactly', () => {
    render(<RosterUtilization committedTotal={20} cap={25} pendingAdds={5} pendingRemoves={0} />);
    expect(screen.getByText(/25 \/ 25 seats pending/)).toBeInTheDocument();
    // total === cap → near (>= 0.9) but not over.
    const fills = Array.from(document.querySelectorAll('.utilization-fill')) as HTMLElement[];
    expect(fills[1]?.className).toContain('near');
    expect(fills[1]?.className).not.toContain('over');
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
    const fills = Array.from(document.querySelectorAll('.utilization-fill')) as HTMLElement[];
    expect(fills[0]?.className).toContain('over');
    // Pending = 25 → exactly cap → near, not over.
    expect(fills[1]?.className).toContain('near');
    expect(fills[1]?.className).not.toContain('over');
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
