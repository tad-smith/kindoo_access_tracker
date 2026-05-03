// Component tests for the Notifications page wrapper. The page
// component is role-agnostic — the route file owns the gate. This
// test verifies the wrapper renders the panel and the standard
// page chrome (heading + subtitle).

import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

// Stub the panel so this test stays focused on the page wrapper.
vi.mock('../components/PushNotificationsPanel', () => ({
  PushNotificationsPanel: () => <div data-testid="push-notifications-panel" />,
}));

import { NotificationsPage } from '../pages/NotificationsPage';

function Wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe('<NotificationsPage />', () => {
  it('renders the page heading + subtitle', () => {
    render(<NotificationsPage />, { wrapper: Wrapper });
    expect(screen.getByRole('heading', { level: 1, name: /Notifications/i })).toBeInTheDocument();
    expect(screen.getByText(/each browser or phone/i)).toBeInTheDocument();
  });

  it('renders the Push Notifications panel', () => {
    render(<NotificationsPage />, { wrapper: Wrapper });
    expect(screen.getByTestId('push-notifications-panel')).toBeInTheDocument();
  });
});
