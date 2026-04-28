// Component tests for the toast host. Verifies the queue → DOM
// connection: enqueueing a toast renders it; clicking it dismisses.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToastHost } from './Toast';
import { toast, useToastStore } from '../../lib/store/toast';

beforeEach(() => {
  useToastStore.getState().clear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ToastHost', () => {
  it('renders nothing when the queue is empty', () => {
    const { container } = render(<ToastHost />);
    expect(container.querySelector('.toast-host')).toBeNull();
  });

  it('renders a queued toast', () => {
    render(<ToastHost />);
    act(() => {
      toast('Saved.');
    });
    expect(screen.getByText('Saved.')).toBeInTheDocument();
  });

  it('applies the kind-specific css class', () => {
    render(<ToastHost />);
    act(() => {
      toast('Failed.', 'error');
    });
    expect(screen.getByText('Failed.').className).toContain('toast-error');
  });

  it('dismisses a toast when clicked', async () => {
    const user = userEvent.setup();
    render(<ToastHost />);
    act(() => {
      toast('Click me.');
    });
    await user.click(screen.getByText('Click me.'));
    expect(screen.queryByText('Click me.')).toBeNull();
  });
});
