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
import './Popover.css';

export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;
export const PopoverAnchor = PopoverPrimitive.Anchor;
// Dismisses the popover. A Popover has no item semantics (unlike
// DropdownMenu), so a plain button inside the content does NOT close it
// — wrap such a button in `<PopoverClose asChild>` when selecting it
// should dismiss. Radix composes the handlers and returns focus to the
// trigger on close.
export const PopoverClose = PopoverPrimitive.Close;

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
          // Layer comes from Popover.css, not a Tailwind `z-` class: it
          // has to clear the modal positioner (1301), which is outside
          // Tailwind's scale.
          'kd-popover-content rounded border border-kd-border bg-white p-0 shadow-md outline-none',
          'data-[state=open]:animate-in data-[state=closed]:animate-out',
          className,
        )}
        {...rest}
      />
    </PopoverPrimitive.Portal>
  );
});
