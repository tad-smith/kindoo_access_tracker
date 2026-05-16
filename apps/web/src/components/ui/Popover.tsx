// Popover primitive — Radix-backed floating panel. Used by the
// Combobox/typeahead on the New Request form's `reason` field.
//
// API mirrors Radix:
//
//   <Popover open={open} onOpenChange={setOpen}>
//     <PopoverTrigger asChild>...trigger...</PopoverTrigger>
//     <PopoverContent>...panel body...</PopoverContent>
//   </Popover>

import * as PopoverPrimitive from '@radix-ui/react-popover';
import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from 'react';
import { cn } from '../../lib/cn';

export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;
export const PopoverAnchor = PopoverPrimitive.Anchor;

export const PopoverContent = forwardRef<
  ElementRef<typeof PopoverPrimitive.Content>,
  ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>
>(function PopoverContent({ className, align = 'start', sideOffset = 4, ...rest }, ref) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        ref={ref}
        align={align}
        sideOffset={sideOffset}
        className={cn(
          'z-50 rounded border border-kd-border bg-white p-0 shadow-md outline-none',
          'data-[state=open]:animate-in data-[state=closed]:animate-out',
          className,
        )}
        {...rest}
      />
    </PopoverPrimitive.Portal>
  );
});
