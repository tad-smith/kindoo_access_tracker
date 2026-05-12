// shadcn-style UI primitives. Dialog + Toast are hand-rolled Radix
// wrappers; Button / Badge / Card / Input / Select / Skeleton are
// Tailwind-styled shadcn-pattern components.
//
// Per shadcn convention these are *our code* — copy-pasted shapes we
// can customise freely. The dependency floor is `@radix-ui/react-slot`
// (for Button asChild), `clsx` + `tailwind-merge` (`cn`), and
// `class-variance-authority` (reserved for variant tables larger than
// the simple switches we use here).

export { Badge, type BadgeProps, type BadgeVariant } from './Badge';
export { Button, type ButtonProps, type ButtonVariant } from './Button';
export { Card, CardContent, CardFooter, CardHeader, CardTitle } from './Card';
export {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  type CollapsibleTriggerProps,
} from './Collapsible';
export { Input } from './Input';
export { Select } from './Select';
export { Skeleton } from './Skeleton';
