// Tailwind class-merging helper. Same shape as the shadcn-ui-canonical
// `cn` (`clsx` + `tailwind-merge`) — every shadcn component composes
// its `className` prop through this so callers can override generated
// utility classes without dealing with class-collision footguns.
//
// Pure function, no Firebase / DOM deps; safe to import from anywhere.

import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
