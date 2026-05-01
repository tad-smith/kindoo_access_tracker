// Small colored chip / pill. Used for seat type ("auto" / "manual" /
// "temp"), request type / status, expiry warnings, removal-pending,
// access source, audit action category. Visual mirrors the
// `roster-badge` family from the Apps Script `Styles.html`.
//
// Variant choice falls back to `default` (neutral grey). All variants
// are background+foreground+border tuples driven by Tailwind utility
// classes referencing the design tokens declared in
// `src/styles/tailwind.css`.

import type { HTMLAttributes } from 'react';
import { cn } from '../../lib/cn';

export type BadgeVariant =
  | 'default'
  | 'auto'
  | 'manual'
  | 'temp'
  | 'success'
  | 'warning'
  | 'danger'
  | 'info'
  // Audit-action category badges. Mirror Apps Script's four
  // `audit-action-*` classes (Styles.html lines 1881-1884) exactly so
  // the manager Audit Log row chips render with the Apps Script
  // palette: blue for CRUD, green for request lifecycle, red for
  // system events, amber for importer.
  | 'audit-crud'
  | 'audit-request'
  | 'audit-system'
  | 'audit-import';

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
}

// Roster type-pill colors mirror Apps Script `Styles.html` lines 814-
// 816 exactly: auto = blue (primary-tint / primary), manual = warm
// amber (warn-tint / warn-dark), temp = light amber (warn-tint-2 /
// warn-mid).
const VARIANT_CLASSES: Record<BadgeVariant, string> = {
  default: 'bg-kd-border-soft text-kd-fg-2',
  auto: 'bg-kd-primary-tint text-kd-primary',
  manual: 'bg-kd-warn-tint text-kd-warn-dark',
  temp: 'bg-kd-warn-tint-2 text-kd-warn-mid',
  success: 'bg-kd-success-tint text-kd-success-fg border border-kd-success-br',
  warning: 'bg-kd-warn-tint text-kd-warn-mid',
  danger: 'bg-kd-danger-bg text-kd-danger-fg border border-kd-danger',
  info: 'bg-kd-primary-tint text-kd-primary-hover',
  // Apps Script's `.audit-action-badge` is uppercase + font-weight
  // 600. Layer those modifiers per-variant so they stack with the
  // base Badge classes (which set rounded + padding + text-xs).
  // #ebf4fb / #2b6cb0
  'audit-crud': 'bg-kd-primary-tint text-kd-primary uppercase font-semibold',
  // #e6f3ea / #2f6f47
  'audit-request': 'bg-kd-success-tint text-kd-success-fg uppercase font-semibold',
  // #f5e4e4 / #923834
  'audit-system': 'bg-kd-danger-tint text-kd-danger-fg uppercase font-semibold',
  // #fde4a1 / #6b4a00
  'audit-import': 'bg-kd-warn-tint-2 text-kd-warn-mid uppercase font-semibold',
};

export function Badge({ variant = 'default', className, ...rest }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium leading-tight whitespace-nowrap',
        VARIANT_CLASSES[variant],
        className,
      )}
      {...rest}
    />
  );
}
