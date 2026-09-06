// The "i" affordance. Its whole reason for existing is that it works on
// a touch device, so the tap path is what these assert — not that a
// Popover renders.

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { InfoTip } from './InfoTip';

function setup() {
  return render(
    <form onSubmit={() => expect.unreachable('the trigger must not submit its host form')}>
      <InfoTip label="Sync reminders" data-testid="tip">
        <p>What the setting does.</p>
      </InfoTip>
    </form>,
  );
}

describe('<InfoTip />', () => {
  it('keeps its content closed until the affordance is used', () => {
    setup();
    expect(screen.getByTestId('tip')).toBeInTheDocument();
    expect(screen.queryByText('What the setting does.')).toBeNull();
  });

  it('opens on a click, which is also what a tap produces', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByTestId('tip'));
    expect(await screen.findByText('What the setting does.')).toBeVisible();
  });

  it('does not need a hover, which a phone or iPad never produces', async () => {
    const user = userEvent.setup();
    setup();
    await user.hover(screen.getByTestId('tip'));
    expect(screen.queryByText('What the setting does.')).toBeNull();
  });

  it('closes again on Escape', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByTestId('tip'));
    await screen.findByText('What the setting does.');
    await user.keyboard('{Escape}');
    expect(screen.queryByText('What the setting does.')).toBeNull();
  });

  it('opens on the side a caller asks for, when the default would land on something', async () => {
    const user = userEvent.setup();
    render(
      <InfoTip label="Sync reminders" side="top" data-testid="tip">
        <p>What the setting does.</p>
      </InfoTip>,
    );
    await user.click(screen.getByTestId('tip'));
    expect(await screen.findByTestId('tip-panel')).toHaveAttribute('data-side', 'top');
  });

  it('leaves placement alone for the callers that do not ask, so adding the prop moved nothing', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByTestId('tip'));
    // Radix's own default, not one this component imposes.
    expect(await screen.findByTestId('tip-panel')).toHaveAttribute('data-side', 'bottom');
  });

  it('names the setting it explains, so several on one page stay distinguishable', () => {
    setup();
    expect(screen.getByTestId('tip')).toHaveAttribute('aria-label', 'More about Sync reminders');
  });

  it('is a plain button, so placing one inside a form cannot submit it', async () => {
    const user = userEvent.setup();
    setup();
    expect(screen.getByTestId('tip')).toHaveAttribute('type', 'button');
    // The host form's onSubmit fails the test if this click submits.
    await user.click(screen.getByTestId('tip'));
  });
});
