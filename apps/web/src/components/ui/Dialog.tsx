// Accessible modal primitive. Built on Radix UI's Dialog so we get
// the hard parts for free: focus-trap, ESC-to-close, scroll-lock on
// body, inert background, ARIA labelling. shadcn-ui's Dialog is the
// same Radix base layered with Tailwind classes; we use the Radix
// primitive directly + plain CSS for a minimal dependency surface.
//
// API surface: `Dialog` + `Dialog.ConfirmButton` / `Dialog.CancelButton`
// / `Dialog.Footer`. Page code composes:
//
//   <Dialog open={open} onOpenChange={setOpen} title="Mark complete?">
//     <p>Approve and write seat for {request.member_email}?</p>
//     <Dialog.Footer>
//       <Dialog.CancelButton>Cancel</Dialog.CancelButton>
//       <Dialog.ConfirmButton onClick={onConfirm}>Confirm</Dialog.ConfirmButton>
//     </Dialog.Footer>
//   </Dialog>
//
// The component pushes itself onto the cross-page modal stack on open
// and pops on close so feature code can query "is any modal open?"
// without poking the DOM.

import * as RadixDialog from '@radix-ui/react-dialog';
import { useEffect, useId, useRef, type ReactNode, type ButtonHTMLAttributes } from 'react';
import { useModalStackStore } from '../../lib/store/modalStack';
import './Dialog.css';

export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  /** Optional override for the unique stack ID (defaults to a generated one). */
  stackId?: string;
  /**
   * When `false`, blocks the two implicit dismissal paths — Escape key
   * and pointer-down outside the content — so the dialog stays open
   * until the caller flips `open` itself. Use for in-flight async work
   * where dismissing mid-operation would desync UI from the pending
   * result. Defaults to `true` (normal dismissable modal).
   */
  dismissable?: boolean;
  /**
   * When `false`, the dialog opens with **no field focused and no text
   * selected**. Radix's default is to focus the first tabbable
   * descendant and, if it is an input, `select()` its value — so a
   * dialog that opens pre-filled greets the operator with its first
   * field highlighted and one keystroke from being overwritten (B-28).
   *
   * Focus still moves INTO the dialog: it lands on the content node
   * itself, which is the `role="dialog"` element and already carries
   * `tabIndex={-1}` from Radix's own `FocusScope`. Redirecting rather
   * than merely suppressing is what keeps the focus trap armed (the
   * scope's last-in-scope memo is seeded by this focus; left null, a
   * focusin from outside refocuses nothing and focus escapes to the
   * page behind) and what lets screen readers announce the dialog. It
   * also keeps focus off the trigger, which `hideOthers` has just made
   * `aria-hidden` — focus on hidden content is its own defect.
   *
   * Escape is NOT one of the behaviours this preserves: Radix's
   * `DismissableLayer` binds it on `ownerDocument`, so it fires
   * wherever focus sits. Defaults to `true`.
   */
  autoFocusFirstField?: boolean;
}

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  stackId,
  dismissable = true,
  autoFocusFirstField = true,
}: DialogProps) {
  const generatedId = useId();
  const id = stackId ?? generatedId;
  const push = useModalStackStore((state) => state.push);
  const pop = useModalStackStore((state) => state.pop);

  useEffect(() => {
    if (open) {
      push(id);
      return () => pop(id);
    }
    return undefined;
  }, [open, id, push, pop]);

  // When not dismissable, swallow the implicit close gestures. Radix
  // still fires `onOpenChange(false)` for the Close affordance (the
  // Cancel button), so the caller's explicit controls keep working.
  const blockIfLocked = dismissable ? undefined : (e: Event) => e.preventDefault();

  // Opt-out of Radix's focus-the-first-field-and-select-its-text mount
  // behaviour. We redirect focus to the content node rather than merely
  // suppressing it — see `autoFocusFirstField`. `preventScroll` matches
  // what Radix's own `focus()` helper does; the content node is the
  // scroll container, so focusing it without the flag can jump a tall
  // dialog away from its top.
  const contentRef = useRef<HTMLDivElement>(null);
  const focusContentInstead = (e: Event) => {
    e.preventDefault();
    contentRef.current?.focus({ preventScroll: true });
  };

  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="kd-modal" />
        <RadixDialog.Content
          ref={contentRef}
          className="kd-modal-positioner"
          {...(autoFocusFirstField ? {} : { onOpenAutoFocus: focusContentInstead })}
          {...(blockIfLocked
            ? { onEscapeKeyDown: blockIfLocked, onPointerDownOutside: blockIfLocked }
            : {})}
        >
          <div className="kd-modal-inner">
            <RadixDialog.Title className="kd-modal-title">{title}</RadixDialog.Title>
            {description ? (
              <RadixDialog.Description className="kd-modal-body">
                {description}
              </RadixDialog.Description>
            ) : (
              // Radix requires an explicit Description or aria-describedby
              // override; if the caller didn't pass one we hide it from
              // assistive tech rather than fabricating copy.
              <RadixDialog.Description className="kd-modal-sr" />
            )}
            {children}
          </div>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

interface FooterProps {
  children: ReactNode;
}

function Footer({ children }: FooterProps) {
  return <div className="form-actions">{children}</div>;
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement>;

function CancelButton(props: ButtonProps) {
  return (
    <RadixDialog.Close asChild>
      <button type="button" className="btn btn-secondary" {...props} />
    </RadixDialog.Close>
  );
}

function ConfirmButton({ className, ...rest }: ButtonProps) {
  const cls = ['btn', className].filter(Boolean).join(' ');
  return <button type="button" className={cls} {...rest} />;
}

Dialog.Footer = Footer;
Dialog.CancelButton = CancelButton;
Dialog.ConfirmButton = ConfirmButton;
