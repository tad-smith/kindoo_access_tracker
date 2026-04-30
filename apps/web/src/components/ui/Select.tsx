// Native `<select>` styled to match `Input.tsx`. shadcn-ui's Radix Select
// is heavier (popover, custom listbox); we'll graduate to it if a need
// arises. The native a11y story is solid on every platform we ship to.
//
// Why background + chevron live in `pages.css` (`.kd-select`), not as
// Tailwind utilities: the `cn()` helper runs `tailwind-merge`, which
// treats `bg-white` (color) and `bg-[image:url(...)]` (image) as
// conflicting `bg-` utilities and keeps only the last one. We were
// losing the white background and falling through to the Tailwind
// preflight's `background-color: transparent`, which inherited the
// page chrome's grey. Owning the rule in CSS sidesteps the collapse.

import { forwardRef, type SelectHTMLAttributes } from 'react';
import { cn } from '../../lib/cn';

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  function Select({ className, children, ...rest }, ref) {
    return (
      <select
        ref={ref}
        className={cn(
          'kd-select',
          'block w-full rounded border border-kd-border px-3 py-1.5 pr-8 text-sm text-kd-fg-1',
          'focus:outline-none focus:ring-2 focus:ring-kd-primary/40 focus:border-kd-primary',
          'disabled:opacity-60 disabled:cursor-not-allowed',
          className,
        )}
        {...rest}
      >
        {children}
      </select>
    );
  },
);
