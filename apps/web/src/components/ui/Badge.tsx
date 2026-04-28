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
  | 'info';

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
}

const VARIANT_CLASSES: Record<BadgeVariant, string> = {
  default: 'bg-kd-border-soft text-kd-fg-2',
  auto: 'bg-kd-row-auto text-kd-fg-2 border border-kd-border-soft',
  manual: 'bg-kd-primary-tint text-kd-primary-hover border border-kd-primary-tint',
  temp: 'bg-kd-row-temp text-kd-warn-dark border border-kd-warn-tint',
  success: 'bg-kd-success-tint text-kd-success-fg border border-kd-success-br',
  warning: 'bg-kd-warn-tint text-kd-warn-mid',
  danger: 'bg-kd-danger-bg text-kd-danger-fg border border-kd-danger',
  info: 'bg-kd-primary-tint text-kd-primary-hover',
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
