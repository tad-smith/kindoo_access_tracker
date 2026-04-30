// Regression guard for the staging "select renders grey" bug. The
// `tailwind-merge` step inside `cn()` collapses `bg-white` and
// `bg-[image:url(...)]` into a single `bg-` slot and drops the
// background color, leaving the Tailwind preflight's transparent
// fallback. We work around that by owning the chrome in a CSS class
// (`.kd-select`) on top of Tailwind utilities.

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Select } from './Select';

describe('<Select />', () => {
  it('carries the kd-select chrome class so the white background + chevron survive twMerge', () => {
    render(
      <Select aria-label="picker">
        <option value="a">A</option>
      </Select>,
    );
    const select = screen.getByRole('combobox', { name: /picker/i });
    expect(select.className).toContain('kd-select');
  });

  it('preserves caller className overrides through cn()', () => {
    render(
      <Select aria-label="picker" className="extra-class">
        <option value="a">A</option>
      </Select>,
    );
    const select = screen.getByRole('combobox', { name: /picker/i });
    expect(select.className).toContain('extra-class');
    expect(select.className).toContain('kd-select');
  });
});
