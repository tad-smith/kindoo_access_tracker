// Collapsible primitive — Radix-backed expand / collapse container.
// Used by the New Request building selector to give ward users a
// compact default-collapsed header (with their ward's building name
// already selected) plus the ability to expand and pick more.
//
// API mirrors Radix:
//
//   <Collapsible open={open} onOpenChange={setOpen}>
//     <CollapsibleTrigger>...header chrome...</CollapsibleTrigger>
//     <CollapsibleContent>...body...</CollapsibleContent>
//   </Collapsible>
//
// Trigger renders an `aria-expanded` button with a chevron on the
// LEFT that rotates 90deg on open via the `group-data-[state=open]`
// Tailwind variant — no JS, no extra state. Layout: chevron, then
// children laid out inline.

import * as CollapsiblePrimitive from '@radix-ui/react-collapsible';
import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from 'react';
import { ChevronRight } from 'lucide-react';
import { cn } from '../../lib/cn';

export const Collapsible = CollapsiblePrimitive.Root;

export type CollapsibleTriggerProps = ComponentPropsWithoutRef<
  typeof CollapsiblePrimitive.Trigger
> & {
  /** Override the chevron — pass `null` to render no icon. */
  icon?: React.ReactNode;
};

export const CollapsibleTrigger = forwardRef<
  ElementRef<typeof CollapsiblePrimitive.Trigger>,
  CollapsibleTriggerProps
>(function CollapsibleTrigger({ className, children, icon, ...rest }, ref) {
  // Trigger carries `data-state="open" | "closed"`. The chevron uses
  // the `group-data-[state=open]` Tailwind variant so a single CSS
  // rule rotates the right-pointing chevron 90deg into a down-pointing
  // one when the panel is open. Keep a small flex gap between chevron
  // and label so dense one-line headers stay legible.
  const chevron =
    icon === undefined ? (
      <ChevronRight
        aria-hidden
        className="kd-collapsible-chevron h-4 w-4 shrink-0 transition-transform group-data-[state=open]:rotate-90"
      />
    ) : (
      icon
    );
  return (
    <CollapsiblePrimitive.Trigger
      ref={ref}
      className={cn('group inline-flex w-full items-center gap-2 text-left', className)}
      {...rest}
    >
      {chevron}
      <span className="flex-1">{children}</span>
    </CollapsiblePrimitive.Trigger>
  );
});

export const CollapsibleContent = CollapsiblePrimitive.Content;
