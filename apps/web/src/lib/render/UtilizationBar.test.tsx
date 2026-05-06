// Component tests for `<UtilizationBar />`. Mirrors the contract from
// Apps Script's `renderUtilizationBar` so the visual / DOM shape is
// identical — same class names, same OVER CAP label.

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { UtilizationBar } from './UtilizationBar';

function fillEl(): HTMLElement {
  return document.querySelector('.utilization-fill') as HTMLElement;
}

describe('UtilizationBar', () => {
  it('renders a count + cap-unset label when no cap is set', () => {
    const { container } = render(<UtilizationBar total={3} cap={null} />);
    expect(screen.getByText(/3 seats/i)).toBeInTheDocument();
    expect(screen.getByText(/cap unset/i)).toBeInTheDocument();
    // No bar rendered.
    expect(container.querySelector('.utilization-bar')).toBeNull();
  });

  it('singularises "seat" when total is exactly 1', () => {
    render(<UtilizationBar total={1} cap={undefined} />);
    expect(screen.getByText(/^1 seat$/)).toBeInTheDocument();
  });

  it('renders a blue fill below 90% utilization', () => {
    render(<UtilizationBar total={10} cap={20} />);
    expect(screen.getByText(/10 \/ 20 seats used/)).toBeInTheDocument();
    expect(fillEl().className).toBe('utilization-fill');
    expect(fillEl().style.width).toBe('50%');
  });

  it('renders an amber fill at >= 90% utilization', () => {
    render(<UtilizationBar total={18} cap={20} />);
    expect(fillEl().className).toContain('near');
    expect(fillEl().className).not.toContain('over');
    // No OVER CAP label until over_cap is true.
    expect(screen.queryByText(/OVER CAP/)).toBeNull();
  });

  it('renders a red fill + OVER CAP label when overCap is set', () => {
    render(<UtilizationBar total={22} cap={20} overCap />);
    expect(fillEl().className).toContain('over');
    expect(screen.getByText(/OVER CAP/)).toBeInTheDocument();
  });

  it('clamps the bar width to 100% even when over cap', () => {
    render(<UtilizationBar total={50} cap={10} overCap />);
    expect(fillEl().style.width).toBe('100%');
  });

  it('treats a non-positive cap as cap-unset', () => {
    const { container } = render(<UtilizationBar total={5} cap={0} />);
    expect(screen.getByText(/cap unset/i)).toBeInTheDocument();
    expect(container.querySelector('.utilization-bar')).toBeNull();
  });

  it('clamps a negative total to zero', () => {
    render(<UtilizationBar total={-5} cap={10} />);
    expect(screen.getByText(/0 \/ 10 seats used/)).toBeInTheDocument();
    expect(fillEl().style.width).toBe('0%');
  });

  describe('inline layout', () => {
    it('puts the bar before the label in DOM order so the label sits to the right', () => {
      const { container } = render(<UtilizationBar total={10} cap={20} layout="inline" />);
      const wrapper = container.querySelector('.utilization');
      expect(wrapper?.className).toContain('layout-inline');
      const children = Array.from(wrapper?.children ?? []);
      // First child is the bar, second is the label — that DOM order
      // is what produces the "[bar] [label]" reading order with the
      // flex-row layout.
      expect(children[0]?.className).toContain('utilization-bar');
      expect(children[1]?.className).toContain('utilization-label');
    });

    it('keeps stacked layout (label above bar) as the default', () => {
      const { container } = render(<UtilizationBar total={10} cap={20} />);
      const wrapper = container.querySelector('.utilization');
      expect(wrapper?.className).toContain('layout-stacked');
      const children = Array.from(wrapper?.children ?? []);
      expect(children[0]?.className).toContain('utilization-label');
      expect(children[1]?.className).toContain('utilization-bar');
    });
  });

  describe('verb prop', () => {
    it('uses "used" by default', () => {
      render(<UtilizationBar total={5} cap={10} />);
      expect(screen.getByText(/5 \/ 10 seats used/)).toBeInTheDocument();
    });

    it('swaps the trailing word to "pending" when verb=pending', () => {
      render(<UtilizationBar total={5} cap={10} verb="pending" />);
      expect(screen.getByText(/5 \/ 10 seats pending/)).toBeInTheDocument();
      expect(screen.queryByText(/5 \/ 10 seats used/)).toBeNull();
    });
  });

  describe('tone prop', () => {
    it('adds the tone-muted class when tone=muted', () => {
      const { container } = render(<UtilizationBar total={5} cap={10} tone="muted" />);
      expect(container.querySelector('.utilization')?.className).toContain('tone-muted');
    });

    it('omits the tone-muted class by default', () => {
      const { container } = render(<UtilizationBar total={5} cap={10} />);
      expect(container.querySelector('.utilization')?.className).not.toContain('tone-muted');
    });
  });

  describe('accent prop', () => {
    it('forces the amber `near` fill when accent=warn even at low utilization', () => {
      // 2 / 25 = 8% — would normally render the default blue fill.
      render(<UtilizationBar total={2} cap={25} accent="warn" />);
      expect(fillEl().className).toContain('near');
    });

    it('still defers to over-cap red when both accent=warn and overCap', () => {
      render(<UtilizationBar total={30} cap={25} overCap accent="warn" />);
      expect(fillEl().className).toContain('over');
      expect(fillEl().className).not.toContain('near');
    });

    it('falls back to the auto fill rule when accent=auto (the default)', () => {
      render(<UtilizationBar total={5} cap={25} />);
      // 5 / 25 = 20% → default blue.
      expect(fillEl().className).toBe('utilization-fill');
    });
  });
});
