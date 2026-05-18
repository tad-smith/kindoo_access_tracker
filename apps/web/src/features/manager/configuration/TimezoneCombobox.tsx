// Combobox for the Configuration > Config tab's `timezone` field.
//
// Surfaces the curated US-relevant IANA timezone list from
// `usTimezones.ts`. Behaviour:
//
//   - Click the trigger button to open the popover and reveal the list.
//   - Type-to-filter on either the IANA name or the display string,
//     case-insensitive substring (cmdk's default scorer covers this).
//   - Up/Down/Enter selects; Esc closes.
//   - The component is controlled (`value` / `onChange`) so it slots
//     into react-hook-form via `Controller`.
//   - If the current value is NOT in the curated list (a legacy
//     free-form string written before this control existed), it is
//     rendered as the trigger's selected label with a "(legacy)"
//     suffix and surfaced as a separate "Current value" group at the
//     top of the list so the user can keep it without retyping. Picking
//     anything else from the list replaces the legacy value as usual.
//
// We are NOT enforcing "must be in the curated list" on save — that
// stays a `z.string().trim().min(1)` schema check, identical to today.

import { useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
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
import { US_TIMEZONES, US_TIMEZONE_SET, type UsTimezoneOption } from './usTimezones';

export interface TimezoneComboboxProps {
  /** Current IANA value. */
  value: string;
  /** Called when the user picks an option from the list. */
  onChange: (next: string) => void;
  /** Underlying button id (so a wrapping `<label>` can target it). */
  id?: string;
  /** Test selector hook. */
  'data-testid'?: string;
}

export function TimezoneCombobox({
  value,
  onChange,
  id,
  'data-testid': testId,
}: TimezoneComboboxProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const generatedId = useId();
  const buttonId = id ?? generatedId;

  const selectedOption: UsTimezoneOption | undefined = useMemo(
    () => US_TIMEZONES.find((tz) => tz.iana === value),
    [value],
  );

  const isLegacy = value !== '' && !US_TIMEZONE_SET.has(value);

  const handleSelect = (next: string) => {
    onChange(next);
    setOpen(false);
    setQuery('');
    // Restore focus so keyboard users keep their place in the form.
    triggerRef.current?.focus();
  };

  const handleTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setOpen(true);
    }
  };

  const triggerLabel = (() => {
    if (value === '') return 'Select a timezone';
    if (selectedOption) return `${selectedOption.iana} — ${selectedOption.display}`;
    return `${value} (legacy)`;
  })();

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <button
          ref={triggerRef}
          id={buttonId}
          type="button"
          role="combobox"
          aria-expanded={open}
          aria-haspopup="listbox"
          onClick={() => setOpen((prev) => !prev)}
          onKeyDown={handleTriggerKeyDown}
          data-testid={testId}
          className={cn(
            'flex w-full items-center justify-between rounded border border-kd-border bg-white px-3 py-1.5 text-left text-sm text-kd-fg-1',
            'focus:outline-none focus:ring-2 focus:ring-kd-primary/40 focus:border-kd-primary',
            'disabled:opacity-60 disabled:cursor-not-allowed',
          )}
        >
          <span className={cn('truncate', value === '' && 'text-kd-fg-3')}>{triggerLabel}</span>
          <span aria-hidden className="ml-2 text-kd-fg-3">
            ▾
          </span>
        </button>
      </PopoverAnchor>
      <PopoverContent
        align="start"
        sideOffset={4}
        className="w-[var(--radix-popover-trigger-width)] p-0"
      >
        <Command shouldFilter>
          <CommandInput
            value={query}
            onValueChange={setQuery}
            placeholder="Search timezones…"
            data-testid={testId ? `${testId}-search` : undefined}
          />
          <CommandList data-testid={testId ? `${testId}-list` : undefined}>
            <CommandEmpty data-testid={testId ? `${testId}-empty` : undefined}>
              No matching timezone.
            </CommandEmpty>
            {isLegacy ? (
              <CommandGroup heading="Current value">
                <CommandItem
                  key={`legacy-${value}`}
                  // cmdk filters on `value`; including the suffix means
                  // typing "legacy" surfaces this row.
                  value={`${value} legacy`}
                  onSelect={() => handleSelect(value)}
                  data-testid={testId ? `${testId}-option-legacy` : undefined}
                >
                  {value} (legacy)
                </CommandItem>
              </CommandGroup>
            ) : null}
            <CommandGroup heading="United States">
              {US_TIMEZONES.map((tz) => (
                <CommandItem
                  key={tz.iana}
                  // Concatenate both fields so cmdk's substring match
                  // surfaces hits on either the IANA name or the
                  // friendly display string.
                  value={`${tz.iana} ${tz.display}`}
                  onSelect={() => handleSelect(tz.iana)}
                  data-testid={testId ? `${testId}-option-${tz.iana}` : undefined}
                >
                  <span className="font-mono text-xs text-kd-fg-2">{tz.iana}</span>
                  <span className="ml-2 text-kd-fg-1">— {tz.display}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
