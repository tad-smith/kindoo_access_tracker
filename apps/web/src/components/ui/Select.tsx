// Native `<select>` styled to match `Input.tsx`. shadcn-ui's Radix Select
// is heavier (popover, custom listbox); we'll graduate to it if a need
// arises. The native a11y story is solid on every platform we ship to.
//
// Background: `bg-white` (color) and the inline-SVG `bg-[image:url(...)]`
// (image) must both be set so the rendered background is white-with-
// chevron, not browser-default light grey. Tailwind shorthands collapse
// when both `bg-<color>` and `bg-[url(...)]` (without explicit `image:`
// prefix) appear; the explicit `image:` namespace prevents that.

import { forwardRef, type SelectHTMLAttributes } from 'react';
import { cn } from '../../lib/cn';

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  function Select({ className, children, ...rest }, ref) {
    return (
      <select
        ref={ref}
        className={cn(
          'block w-full appearance-none rounded border border-kd-border bg-white px-3 py-1.5 pr-8 text-sm text-kd-fg-1',
          'focus:outline-none focus:ring-2 focus:ring-kd-primary/40 focus:border-kd-primary',
          'disabled:opacity-60 disabled:cursor-not-allowed',
          'bg-[length:14px] bg-no-repeat bg-[right_8px_center]',
          // Inline chevron SVG so we don't need an extra image asset.
          // `image:` prefix keeps the bg-color (white) from collapsing
          // with the bg-image declaration into a single shorthand that
          // drops the color.
          "bg-[image:url('data:image/svg+xml;utf8,<svg%20xmlns=%22http://www.w3.org/2000/svg%22%20viewBox=%220%200%2020%2020%22%20fill=%22none%22%20stroke=%22%236b7280%22%20stroke-width=%221.6%22%20stroke-linecap=%22round%22%20stroke-linejoin=%22round%22><polyline%20points=%226,8%2010,12%2014,8%22/></svg>')]",
          className,
        )}
        {...rest}
      >
        {children}
      </select>
    );
  },
);
