// Component tests for `<EmptyState />`. Renders the "Nothing to show"
// placeholder used by every list page.

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { EmptyState } from './EmptyState';

describe('EmptyState', () => {
  it('renders the default message when none is provided', () => {
    render(<EmptyState />);
    expect(screen.getByRole('status')).toHaveTextContent(/Nothing to show/);
  });

  it('renders the supplied message', () => {
    render(<EmptyState message="No seats yet." />);
    expect(screen.getByText(/No seats yet/)).toBeInTheDocument();
  });

  it('renders supplementary children below the message', () => {
    render(
      <EmptyState message="No requests pending.">
        <a href="/stake/new">Submit a new one</a>
      </EmptyState>,
    );
    expect(screen.getByRole('link', { name: /Submit a new one/ })).toBeInTheDocument();
  });
});
