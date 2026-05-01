// Tests for the update-prompt strip. Mocks the SW hook to drive
// `needRefresh` and verifies the toast surfaces, "Refresh" calls update,
// and "Later" dismisses without reloading.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const swState = {
  needRefresh: false,
  offlineReady: false,
  update: vi.fn().mockResolvedValue(undefined),
  dismissNeedRefresh: vi.fn(),
  dismissOfflineReady: vi.fn(),
};

vi.mock('../../lib/pwa/useServiceWorker', () => ({
  useServiceWorker: () => swState,
}));

import { PwaUpdatePrompt } from './PwaUpdatePrompt';

beforeEach(() => {
  swState.needRefresh = false;
  swState.update.mockClear();
  swState.dismissNeedRefresh.mockClear();
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
    expect(screen.getByRole('button', { name: /Refresh/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Later|Dismiss/ })).toBeInTheDocument();
  });

  it('clicking Refresh triggers the update', async () => {
    swState.needRefresh = true;
    const user = userEvent.setup();
    render(<PwaUpdatePrompt />);
    await user.click(screen.getByRole('button', { name: /Refresh/ }));
    expect(swState.update).toHaveBeenCalledOnce();
  });

  it('clicking Later dismisses the prompt without reloading', async () => {
    swState.needRefresh = true;
    const user = userEvent.setup();
    render(<PwaUpdatePrompt />);
    await user.click(screen.getByRole('button', { name: /Later|Dismiss/ }));
    expect(swState.dismissNeedRefresh).toHaveBeenCalledOnce();
    expect(swState.update).not.toHaveBeenCalled();
  });
});
