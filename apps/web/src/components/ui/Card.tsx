// Generic Card / CardHeader / CardTitle / CardContent / CardFooter
// scaffold — same shape as shadcn-ui's canonical Card primitive but
// using Tailwind utility classes referencing our design tokens.
//
// Used by the manager Dashboard cards and the All Seats per-scope
// summary cards.

import { forwardRef, type HTMLAttributes } from 'react';
import { cn } from '../../lib/cn';

export const Card = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(function Card(
  { className, ...rest },
  ref,
) {
  return (
    <div
      ref={ref}
      className={cn('rounded-md border border-kd-border bg-white p-4 shadow-sm', className)}
      {...rest}
    />
  );
});

export const CardHeader = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  function CardHeader({ className, ...rest }, ref) {
    return <div ref={ref} className={cn('mb-2', className)} {...rest} />;
  },
);

export const CardTitle = forwardRef<HTMLHeadingElement, HTMLAttributes<HTMLHeadingElement>>(
  function CardTitle({ className, ...rest }, ref) {
    return (
      <h2
        ref={ref}
        className={cn('text-base font-semibold text-kd-fg-1 m-0', className)}
        {...rest}
      />
    );
  },
);

export const CardContent = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  function CardContent({ className, ...rest }, ref) {
    return <div ref={ref} className={cn('text-sm text-kd-fg-2', className)} {...rest} />;
  },
);

export const CardFooter = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  function CardFooter({ className, ...rest }, ref) {
    return <div ref={ref} className={cn('mt-3 text-xs text-kd-fg-3', className)} {...rest} />;
  },
);
