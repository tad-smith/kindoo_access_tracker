// shadcn-pattern Command primitive wrapping `cmdk`. Provides the
// keyboard-navigable list + filter input used to build comboboxes
// (e.g. the typeahead on the New Request form's calling field).
//
// Default filter is cmdk's built-in command-score (substring +
// case-insensitive). The wrapper just layers Tailwind classes onto
// the cmdk primitives so callers don't have to.

import { Command as CommandPrimitive } from 'cmdk';
import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from 'react';
import { cn } from '../../lib/cn';

export const Command = forwardRef<
  ElementRef<typeof CommandPrimitive>,
  ComponentPropsWithoutRef<typeof CommandPrimitive>
>(function Command({ className, ...rest }, ref) {
  return (
    <CommandPrimitive
      ref={ref}
      className={cn(
        'flex w-full flex-col overflow-hidden rounded bg-white text-kd-fg-1',
        className,
      )}
      {...rest}
    />
  );
});

export const CommandInput = forwardRef<
  ElementRef<typeof CommandPrimitive.Input>,
  ComponentPropsWithoutRef<typeof CommandPrimitive.Input>
>(function CommandInput({ className, ...rest }, ref) {
  return (
    <div className="flex items-center border-b border-kd-border px-3 py-2">
      <CommandPrimitive.Input
        ref={ref}
        className={cn(
          'flex w-full bg-transparent text-sm outline-none placeholder:text-kd-fg-3',
          'disabled:opacity-60 disabled:cursor-not-allowed',
          className,
        )}
        {...rest}
      />
    </div>
  );
});

export const CommandList = forwardRef<
  ElementRef<typeof CommandPrimitive.List>,
  ComponentPropsWithoutRef<typeof CommandPrimitive.List>
>(function CommandList({ className, ...rest }, ref) {
  return (
    <CommandPrimitive.List
      ref={ref}
      className={cn('max-h-64 overflow-y-auto overflow-x-hidden', className)}
      {...rest}
    />
  );
});

export const CommandEmpty = forwardRef<
  ElementRef<typeof CommandPrimitive.Empty>,
  ComponentPropsWithoutRef<typeof CommandPrimitive.Empty>
>(function CommandEmpty({ className, ...rest }, ref) {
  return (
    <CommandPrimitive.Empty
      ref={ref}
      className={cn('px-3 py-3 text-sm text-kd-fg-3', className)}
      {...rest}
    />
  );
});

export const CommandGroup = forwardRef<
  ElementRef<typeof CommandPrimitive.Group>,
  ComponentPropsWithoutRef<typeof CommandPrimitive.Group>
>(function CommandGroup({ className, ...rest }, ref) {
  return <CommandPrimitive.Group ref={ref} className={cn('p-1', className)} {...rest} />;
});

export const CommandItem = forwardRef<
  ElementRef<typeof CommandPrimitive.Item>,
  ComponentPropsWithoutRef<typeof CommandPrimitive.Item>
>(function CommandItem({ className, ...rest }, ref) {
  return (
    <CommandPrimitive.Item
      ref={ref}
      className={cn(
        'relative flex cursor-pointer select-none items-center rounded px-2 py-1.5 text-sm outline-none',
        'data-[selected=true]:bg-kd-primary-tint data-[selected=true]:text-kd-fg-1',
        'data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50',
        className,
      )}
      {...rest}
    />
  );
});
