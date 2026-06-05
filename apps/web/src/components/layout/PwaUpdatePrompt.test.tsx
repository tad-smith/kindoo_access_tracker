// Tests for the update-prompt strip. Mocks the SW hook to drive
// `needRefresh` and verifies the strip surfaces and that its single
// action — "Update now" — calls the update path. The prompt is
// single-action by design: there is no "Later" / dismiss affordance.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const swState = {
  needRefresh: false,
  offlineReady: false,
  update: vi.fn().mockResolvedValue(undefined),
  dismissOfflineReady: vi.fn(),
};

vi.mock('../../lib/pwa/useServiceWorker', () => ({
  useServiceWorker: () => swState,
}));

import { PwaUpdatePrompt } from './PwaUpdatePrompt';

beforeEach(() => {
  swState.needRefresh = false;
  swState.update.mockClear();
});

describe('PwaUpdatePrompt', () => {
  it('renders nothing when no update is waiting', () => {
    swState.needRefresh = false;
    const { container } = render(<PwaUpdatePrompt />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the update prompt when needRefresh is true', () => {
    swState.needRefresh = true;
    render(<PwaUpdatePrompt />);
    expect(screen.getByText(/Update available/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Update now/ })).toBeInTheDocument();
  });

  it('renders exactly one action — no Later or dismiss button', () => {
    swState.needRefresh = true;
    render(<PwaUpdatePrompt />);
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: /Later|Dismiss/ })).toBeNull();
  });

  it('clicking Update now triggers the update path', async () => {
    swState.needRefresh = true;
    const user = userEvent.setup();
    render(<PwaUpdatePrompt />);
    await user.click(screen.getByRole('button', { name: /Update now/ }));
    expect(swState.update).toHaveBeenCalledOnce();
  });
});
