// Loading-placeholder block. Same shape as shadcn-ui's Skeleton:
// animated grey rounded box. Used by dashboard cards and roster lists
// during the initial Firestore subscription's "no snapshot yet" frame.

import type { HTMLAttributes } from 'react';
import { cn } from '../../lib/cn';

export function Skeleton({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('animate-pulse rounded bg-kd-border-soft', className)} {...rest} />;
}
