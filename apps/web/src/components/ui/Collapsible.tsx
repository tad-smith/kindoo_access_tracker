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
// Trigger renders an `aria-expanded` button with a chevron that
// rotates 180deg via a `data-state` selector — no JS needed for the
// rotation, just CSS transition on `transform`.

import * as CollapsiblePrimitive from '@radix-ui/react-collapsible';
import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from 'react';
import { ChevronDown } from 'lucide-react';
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
  // a `group-data-[state=open]` Tailwind variant so a single CSS rule
  // rotates it 180deg when the panel is open — no JS, no extra state.
  const chevron =
    icon === undefined ? (
      <ChevronDown
        aria-hidden
        className="kd-collapsible-chevron h-4 w-4 shrink-0 transition-transform group-data-[state=open]:rotate-180"
      />
    ) : (
      icon
    );
  return (
    <CollapsiblePrimitive.Trigger
      ref={ref}
      className={cn(
        'group inline-flex w-full items-center justify-between gap-2 text-left',
        className,
      )}
      {...rest}
    >
      <span className="flex-1">{children}</span>
      {chevron}
    </CollapsiblePrimitive.Trigger>
  );
});

export const CollapsibleContent = CollapsiblePrimitive.Content;
