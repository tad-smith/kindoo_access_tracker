// Render tests for the install affordance. The hook is mocked so the
// test exercises only the visibility rule (`canInstall` gate) and the
// click → promptInstall wiring.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const installState = {
  canInstall: false,
  promptInstall: vi.fn().mockResolvedValue('accepted' as const),
};

vi.mock('../../lib/pwa/useInstallPrompt', () => ({
  useInstallPrompt: () => installState,
}));

import { PwaInstallButton } from './PwaInstallButton';

beforeEach(() => {
  installState.canInstall = false;
  installState.promptInstall.mockClear();
});

describe('PwaInstallButton', () => {
  it('renders nothing when the install prompt is unavailable', () => {
    installState.canInstall = false;
    const { container } = render(<PwaInstallButton />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders an Install button when the prompt is available', () => {
    installState.canInstall = true;
    render(<PwaInstallButton />);
    expect(screen.getByRole('button', { name: /Install/ })).toBeInTheDocument();
  });

  it('clicking calls promptInstall', async () => {
    installState.canInstall = true;
    const user = userEvent.setup();
    render(<PwaInstallButton />);
    await user.click(screen.getByRole('button', { name: /Install/ }));
    expect(installState.promptInstall).toHaveBeenCalledOnce();
  });
});
