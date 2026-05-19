// Render + interaction tests for the shared timezone combobox. Reused
// by every form that writes a stake-doc `timezone` field (Configuration
// > Config tab and the Superadmin Create Stake form today). The
// schema-level "non-empty string" rule lives on each caller's schema;
// this file owns the picker UX itself.

import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TimezoneCombobox } from './TimezoneCombobox';

function Harness({ initial = 'America/Denver' }: { initial?: string }) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <span data-testid="value">{value}</span>
      <TimezoneCombobox value={value} onChange={setValue} data-testid="tz" />
    </>
  );
}

describe('<TimezoneCombobox />', () => {
  it('renders the current selection with its IANA name + display hint', () => {
    render(<Harness initial="America/Denver" />);
    const trigger = screen.getByTestId('tz');
    expect(trigger).toHaveTextContent('America/Denver');
    expect(trigger).toHaveTextContent('Mountain Time');
  });

  it('opens the list and shows curated US options on click', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByTestId('tz'));
    // Sample a handful — exhaustive enumeration would add no signal.
    const list = await screen.findByTestId('tz-list');
    expect(within(list).getByText('America/New_York')).toBeInTheDocument();
    expect(within(list).getByText('America/Chicago')).toBeInTheDocument();
    expect(within(list).getByText('Pacific/Honolulu')).toBeInTheDocument();
    // Confirm a non-US zone isn't in the list.
    expect(within(list).queryByText('Europe/London')).toBeNull();
  });

  it('filters the list as the user types', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByTestId('tz'));
    const search = await screen.findByTestId('tz-search');
    await user.type(search, 'honolulu');
    const list = screen.getByTestId('tz-list');
    expect(within(list).getByText('Pacific/Honolulu')).toBeInTheDocument();
    expect(within(list).queryByText('America/New_York')).toBeNull();
  });

  it('updates the value when an option is picked', async () => {
    const user = userEvent.setup();
    render(<Harness initial="America/Denver" />);
    await user.click(screen.getByTestId('tz'));
    const option = await screen.findByTestId('tz-option-America/Chicago');
    await user.click(option);
    expect(screen.getByTestId('value')).toHaveTextContent('America/Chicago');
    // The trigger reflects the new selection's display string.
    expect(screen.getByTestId('tz')).toHaveTextContent('Central Time');
  });

  it('surfaces a legacy value not in the curated list with a "(legacy)" suffix', async () => {
    const user = userEvent.setup();
    render(<Harness initial="Etc/UTC" />);
    const trigger = screen.getByTestId('tz');
    expect(trigger).toHaveTextContent('Etc/UTC (legacy)');
    // The legacy entry also appears in the list under "Current value".
    await user.click(trigger);
    expect(await screen.findByTestId('tz-option-legacy')).toBeInTheDocument();
  });

  it('pins the cmdk highlight to the current selection so a reflexive Enter is a no-op', async () => {
    const user = userEvent.setup();
    render(<Harness initial="America/Denver" />);
    await user.click(screen.getByTestId('tz'));
    // The picker's highlighted row is the current value, not the
    // alphabetically-first option (which would be America/Adak).
    const denver = await screen.findByTestId('tz-option-America/Denver');
    expect(denver).toHaveAttribute('data-selected', 'true');
    const adak = screen.getByTestId('tz-option-America/Adak');
    expect(adak).not.toHaveAttribute('data-selected', 'true');
    // Hit Enter immediately — value must NOT change.
    await user.keyboard('{Enter}');
    expect(screen.getByTestId('value')).toHaveTextContent('America/Denver');
  });

  it('preserves a legacy value until the user explicitly picks something else', async () => {
    const user = userEvent.setup();
    render(<Harness initial="Etc/UTC" />);
    // Open + close without picking — value must survive.
    await user.click(screen.getByTestId('tz'));
    await user.keyboard('{Escape}');
    expect(screen.getByTestId('value')).toHaveTextContent('Etc/UTC');
    // Pick a real entry; legacy value is replaced.
    await user.click(screen.getByTestId('tz'));
    await user.click(await screen.findByTestId('tz-option-America/Los_Angeles'));
    expect(screen.getByTestId('value')).toHaveTextContent('America/Los_Angeles');
  });
});
