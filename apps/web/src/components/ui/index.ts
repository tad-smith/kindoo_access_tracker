// shadcn-style UI primitives. Phase 4 shipped Dialog + Toast as
// hand-rolled Radix wrappers; Phase 5 (T-18) added Tailwind v4 + the
// Button / Badge / Card / Input / Select / Skeleton primitives below.
//
// Per shadcn convention these are *our code* — copy-pasted shapes we
// can customise freely. The dependency floor is `@radix-ui/react-slot`
// (for Button asChild), `clsx` + `tailwind-merge` (`cn`), and
// `class-variance-authority` (reserved for variant tables larger than
// the simple switches we use here).

export { Badge, type BadgeProps, type BadgeVariant } from './Badge';
export { Button, type ButtonProps, type ButtonVariant } from './Button';
export { Card, CardContent, CardFooter, CardHeader, CardTitle } from './Card';
export { Input } from './Input';
export { Select } from './Select';
export { Skeleton } from './Skeleton';
