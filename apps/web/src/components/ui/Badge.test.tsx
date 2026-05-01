// Per-variant class assertions. The roster type pills (auto / manual /
// temp) must match Apps Script `Styles.html` lines 814-816 exactly:
//   - auto:   primary-tint bg, primary fg (blue-on-blue)
//   - manual: warn-tint bg, warn-dark fg (amber-on-amber)
//   - temp:   warn-tint-2 bg, warn-mid fg (light amber)

import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { Badge } from './Badge';

describe('<Badge />', () => {
  it('renders the auto variant with primary-tint bg + primary fg (Apps Script .badge-type-auto)', () => {
    const { container } = render(<Badge variant="auto">auto</Badge>);
    const span = container.querySelector('span');
    expect(span).not.toBeNull();
    expect(span?.className).toContain('bg-kd-primary-tint');
    expect(span?.className).toContain('text-kd-primary');
  });

  it('renders the manual variant with warn-tint bg + warn-dark fg (Apps Script .badge-type-manual)', () => {
    const { container } = render(<Badge variant="manual">manual</Badge>);
    const span = container.querySelector('span');
    expect(span?.className).toContain('bg-kd-warn-tint');
    expect(span?.className).toContain('text-kd-warn-dark');
  });

  it('renders the temp variant with warn-tint-2 bg + warn-mid fg (Apps Script .badge-type-temp)', () => {
    const { container } = render(<Badge variant="temp">temp</Badge>);
    const span = container.querySelector('span');
    expect(span?.className).toContain('bg-kd-warn-tint-2');
    expect(span?.className).toContain('text-kd-warn-mid');
  });

  it('falls back to the default variant when no variant is provided', () => {
    const { container } = render(<Badge>x</Badge>);
    const span = container.querySelector('span');
    expect(span?.className).toContain('bg-kd-border-soft');
  });
});
