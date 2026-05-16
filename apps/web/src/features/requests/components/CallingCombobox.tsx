// Scope-aware typeahead for the New Request form's `reason` field.
// Suggests entries from `WARD_CALLINGS` or `STAKE_CALLINGS` based on
// the current request scope. Free-text outside the suggestion list is
// still accepted — the lists are hints, not validators.
//
// Behavioural notes:
//   - The component is controlled (`value` / `onChange`) so it slots
//     into react-hook-form via `Controller`.
//   - Typed input edits the underlying value directly; selecting a
//     suggestion overwrites the value with the exact calling name.
//   - The popover only opens when there is something to show (the
//     input is focused OR a non-empty value is being filtered). On
//     blur the popover closes after a brief delay so click-to-select
//     still registers.
//   - Scope changes swap the suggestion list immediately but do NOT
//     clear the typed value (operator decision: free-text survives a
//     scope flip).

import { useId, useRef, useState, type KeyboardEvent } from 'react';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '../../../components/ui/Command';
import { Popover, PopoverAnchor, PopoverContent } from '../../../components/ui/Popover';
import { cn } from '../../../lib/cn';
import { STAKE_CALLINGS, WARD_CALLINGS } from '../standardCallings';

export interface CallingComboboxProps {
  /** Current free-text value (typed or selected). */
  value: string;
  /** Called on every keystroke and on suggestion selection. */
  onChange: (next: string) => void;
  /** Form scope — `'stake'` picks STAKE_CALLINGS; anything else picks WARD_CALLINGS. */
  scope: string;
  /** Passes through to the underlying `<input>`. */
  id?: string;
  /** Test selector — matches the previous `new-request-reason` id. */
  'data-testid'?: string;
  /** Optional override for the input's name (RHF wires this for us). */
  name?: string;
  /** Optional placeholder; defaults to a hint about typeahead behaviour. */
  placeholder?: string;
}

export function CallingCombobox({
  value,
  onChange,
  scope,
  id,
  'data-testid': testId,
  name,
  placeholder,
}: CallingComboboxProps) {
  // Derive the suggestion list on every render so a scope swap reflects
  // immediately. STAKE only on exact 'stake'; everything else (ward
  // codes, '') gets the ward list per spec.
  const suggestions = scope === 'stake' ? STAKE_CALLINGS : WARD_CALLINGS;

  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const generatedId = useId();
  const inputId = id ?? generatedId;

  // Blur close is delayed so a mousedown on a CommandItem can dispatch
  // before the popover unmounts. cmdk uses `onSelect` so the click
  // path is `mousedown → onSelect → click`; closing on blur synchronously
  // hides the list before the click registers.
  const blurTimer = useRef<number | null>(null);
  const cancelBlurTimer = () => {
    if (blurTimer.current != null) {
      window.clearTimeout(blurTimer.current);
      blurTimer.current = null;
    }
  };

  const handleSelect = (next: string) => {
    onChange(next);
    setOpen(false);
    // Keep focus on the visible input so keyboard users can continue editing.
    inputRef.current?.focus();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape' && open) {
      event.preventDefault();
      setOpen(false);
    } else if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && !open) {
      // Open on arrow navigation even from an empty value so users can
      // browse the list without typing.
      setOpen(true);
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <input
          ref={inputRef}
          id={inputId}
          name={name}
          type="text"
          autoComplete="off"
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
            if (!open) setOpen(true);
          }}
          onFocus={() => {
            cancelBlurTimer();
            setOpen(true);
          }}
          onBlur={() => {
            blurTimer.current = window.setTimeout(() => {
              setOpen(false);
            }, 150);
          }}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          data-testid={testId}
          className={cn(
            'block w-full rounded border border-kd-border bg-white px-3 py-1.5 text-sm text-kd-fg-1',
            'placeholder:text-kd-fg-3',
            'focus:outline-none focus:ring-2 focus:ring-kd-primary/40 focus:border-kd-primary',
            'disabled:opacity-60 disabled:cursor-not-allowed',
          )}
        />
      </PopoverAnchor>
      <PopoverContent
        align="start"
        sideOffset={4}
        className="w-[var(--radix-popover-trigger-width)] p-0"
        // Prevent Radix from stealing focus back from the input when the
        // popover mounts. We want typing to continue uninterrupted.
        onOpenAutoFocus={(e) => e.preventDefault()}
        onCloseAutoFocus={(e) => e.preventDefault()}
        // Cancel the blur-close timer if the user mouses into the panel.
        onMouseDown={cancelBlurTimer}
      >
        <Command
          // Filter against the typed value, not cmdk's internal search
          // state — the visible input is the source of truth.
          shouldFilter
          value=""
          // cmdk filters on its own Input. We feed it the typed value via
          // its hidden CommandInput, kept in sync below.
        >
          <CommandInput
            value={value}
            onValueChange={onChange}
            // The CommandInput is the cmdk-internal text source but we
            // want the *outer* anchor input to be the visible one. Hide
            // the inner input from sight + screen readers; the outer
            // input carries the label and aria-controls relationship.
            className="sr-only"
            tabIndex={-1}
            aria-hidden
          />
          <CommandList data-testid={testId ? `${testId}-list` : undefined}>
            <CommandEmpty data-testid={testId ? `${testId}-empty` : undefined}>
              No matching calling. Free-text reason will be saved.
            </CommandEmpty>
            <CommandGroup>
              {suggestions.map((calling) => (
                <CommandItem
                  key={calling}
                  value={calling}
                  onSelect={handleSelect}
                  data-testid={testId ? `${testId}-option-${calling}` : undefined}
                >
                  {calling}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
