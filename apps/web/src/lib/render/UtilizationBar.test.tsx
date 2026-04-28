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
});
