// Information affordance — the conventional "i" in a circle, sitting
// beside a control whose name alone does not explain it.
//
// Built on `Popover`, not on a hover tooltip, deliberately: managers use
// this app from a phone and an iPad, where there is no hover. A Radix
// Popover trigger opens on click AND on tap, and dismisses on outside
// interaction or Escape.
//
//   <InfoTip label="Email Notifications Enabled">
//     <p>What the setting does.</p>
//   </InfoTip>
//
// `label` names the control for screen readers ("More about X"); it is
// never rendered visually, since the control's own text sits right next
// to it.

import { Info } from 'lucide-react';
import type { ReactNode } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from './Popover';

export interface InfoTipProps {
  /** Name of the setting this explains. Used for the accessible name. */
  label: string;
  children: ReactNode;
  'data-testid'?: string;
}

export function InfoTip({ label, children, 'data-testid': testId }: InfoTipProps) {
  return (
    <Popover>
      <PopoverTrigger
        // `type="button"`: an InfoTip may sit inside a <form>, where a
        // bare <button> would submit it.
        type="button"
        // 24px hit target around a 16px glyph — a finger-sized tap on a
        // phone without the icon reading larger than the label beside it.
        className="inline-flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-full text-kd-fg-3 transition-colors hover:text-kd-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kd-primary focus-visible:ring-offset-1"
        aria-label={`More about ${label}`}
        data-testid={testId}
      >
        <Info className="h-4 w-4" aria-hidden="true" focusable="false" />
      </PopoverTrigger>
      <PopoverContent
        className="max-w-[19rem] p-3 text-[0.85rem] leading-relaxed text-kd-fg-2 [&>p+p]:mt-2 [&>p]:m-0"
        data-testid={testId ? `${testId}-panel` : undefined}
      >
        {children}
      </PopoverContent>
    </Popover>
  );
}
