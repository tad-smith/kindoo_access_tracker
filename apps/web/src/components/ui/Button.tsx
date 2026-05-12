// shadcn-ui Button primitive — adapted to use our existing `.btn` /
// `.btn-secondary` / `.btn-success` / `.btn-danger` CSS in `base.css`.
//
// We deliberately did NOT lift the canonical shadcn Tailwind classes
// here because the existing `.btn` family in `base.css` is matched to
// the design tokens; reusing them keeps the visual language
// consistent. The shadcn-ish API (variant + asChild + forwardRef) is
// preserved so future migration to fully utility-driven shadcn
// classes is a localised edit.
//
// Variants:
//   default  → `btn` (filled blue)
//   secondary → `btn btn-secondary` (white + blue border)
//   success  → `btn btn-success` (filled green)
//   danger   → `btn btn-danger` (filled red)
//   icon     → `btn` with reduced padding for icon-only buttons
//
// `asChild` lets the caller render a different element (typically `<a>`
// for nav links). Same pattern as shadcn's canonical Button.

import { Slot } from '@radix-ui/react-slot';
import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cn } from '../../lib/cn';

export type ButtonVariant = 'default' | 'secondary' | 'success' | 'danger' | 'icon';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  asChild?: boolean;
}

function variantClass(variant: ButtonVariant): string {
  switch (variant) {
    case 'secondary':
      return 'btn btn-secondary';
    case 'success':
      return 'btn btn-success';
    case 'danger':
      return 'btn btn-danger';
    case 'icon':
      return 'btn btn-icon';
    case 'default':
    default:
      return 'btn';
  }
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'default', asChild = false, className, type, ...rest },
  ref,
) {
  const Comp = asChild ? Slot : 'button';
  // Default to type="button" — the HTML default of "submit" is a bug
  // magnet inside forms when a non-submit button accidentally submits.
  // Only buttons explicitly opting into type="submit" should fire form
  // submission.
  const resolvedType = asChild ? undefined : (type ?? 'button');
  return (
    <Comp
      ref={ref}
      className={cn(variantClass(variant), className)}
      {...(resolvedType !== undefined ? { type: resolvedType } : {})}
      {...rest}
    />
  );
});
