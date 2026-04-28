// Plain `<input>` with consistent border, focus, and disabled styling.
// Mirrors shadcn-ui's Input shape (forwardRef, native props pass-through)
// using our design tokens.

import { forwardRef, type InputHTMLAttributes } from 'react';
import { cn } from '../../lib/cn';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, type = 'text', ...rest }, ref) {
    return (
      <input
        ref={ref}
        type={type}
        className={cn(
          'block w-full rounded border border-kd-border bg-white px-3 py-1.5 text-sm text-kd-fg-1',
          'placeholder:text-kd-fg-3',
          'focus:outline-none focus:ring-2 focus:ring-kd-primary/40 focus:border-kd-primary',
          'disabled:opacity-60 disabled:cursor-not-allowed',
          className,
        )}
        {...rest}
      />
    );
  },
);
