// shadcn-ui Switch primitive — Radix-backed toggle for single Boolean
// settings. Use in place of `<input type="checkbox">` whenever the
// control represents an on/off state (not a multi-select item in a
// list). The Radix primitive handles keyboard activation (Space /
// Enter), `role="switch"`, `aria-checked`, and the `disabled` state;
// we add the project's brand-blue (`--kd-primary`) for the on-state
// track + the white thumb that translates 1rem on toggle.
//
// API mirrors shadcn-canonical:
//
//   <Switch
//     checked={value}
//     onCheckedChange={setValue}
//     disabled={isPending}
//     id="some-id"          // pair with <label htmlFor="some-id">
//   />
//
// Visual proportions match shadcn defaults: 44px wide × 24px tall
// track, 20px thumb, 2px padding. Slightly larger than shadcn's own
// canonical sizing because the project's pages use a larger base
// font; the Switch needs to read at the same weight as the surrounding
// labels and existing buttons.

import * as SwitchPrimitive from '@radix-ui/react-switch';
import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from 'react';
import { cn } from '../../lib/cn';

export type SwitchProps = ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>;

export const Switch = forwardRef<ElementRef<typeof SwitchPrimitive.Root>, SwitchProps>(
  function Switch({ className, ...rest }, ref) {
    return (
      <SwitchPrimitive.Root
        ref={ref}
        className={cn(
          // Track — 44×24 with 2px padding around the 20px thumb.
          'peer inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border border-transparent p-0.5 transition-colors',
          // Focus ring — match the project's link/button focus accents.
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kd-primary focus-visible:ring-offset-2',
          // Disabled.
          'disabled:cursor-not-allowed disabled:opacity-50',
          // States — `bg-kd-primary` when on, `bg-kd-border` (light grey) when off.
          'data-[state=checked]:bg-kd-primary data-[state=unchecked]:bg-kd-border',
          className,
        )}
        {...rest}
      >
        <SwitchPrimitive.Thumb
          className={cn(
            // Thumb — 20px circle, white, with a subtle shadow + 1rem
            // translation when on.
            'pointer-events-none block h-5 w-5 rounded-full bg-white shadow ring-0 transition-transform',
            'data-[state=checked]:translate-x-5 data-[state=unchecked]:translate-x-0',
          )}
        />
      </SwitchPrimitive.Root>
    );
  },
);
