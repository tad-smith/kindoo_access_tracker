// Component test for the roster-page Outstanding Requests section.
// Covers the silent-on-empty contract + the badge + the
// add_manual / add_temp visual differentiation through the
// type-banded background colours of the underlying RosterCardList.

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { makeRequest } from '../../../../test/fixtures';
import { PendingAddRequestsSection } from '../components/PendingAddRequestsSection';

describe('<PendingAddRequestsSection />', () => {
  it('renders nothing when there are no pending adds', () => {
    const { container } = render(<PendingAddRequestsSection pendingAdds={[]} />);
    expect(container.querySelector('[data-testid="roster-pending-adds-section"]')).toBeNull();
  });

  it('renders the section header when at least one pending add exists', () => {
    const add = makeRequest({
      request_id: 'r1',
      type: 'add_manual',
      member_email: 'alice@example.com',
      member_name: 'Alice',
      reason: 'Sub teacher',
    });
    render(<PendingAddRequestsSection pendingAdds={[add]} />);
    expect(screen.getByText(/Outstanding Requests/i)).toBeInTheDocument();
  });

  it('renders one card with a Pending badge per pending add', () => {
    const adds = [
      makeRequest({
        request_id: 'r1',
        type: 'add_manual',
        member_canonical: 'a@example.com',
        member_email: 'a@example.com',
        member_name: 'Alice',
      }),
      makeRequest({
        request_id: 'r2',
        type: 'add_temp',
        member_canonical: 'b@example.com',
        member_email: 'b@example.com',
        member_name: 'Bob',
        start_date: '2026-05-01',
        end_date: '2026-05-08',
      }),
    ];
    render(<PendingAddRequestsSection pendingAdds={adds} />);
    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.getByText('Bob')).toBeInTheDocument();
    expect(screen.getAllByTestId('pending-add-badge')).toHaveLength(2);
  });

  it('maps add_temp to the temp-banded card so the temp colour applies', () => {
    const add = makeRequest({
      request_id: 'r1',
      type: 'add_temp',
      member_canonical: 'a@example.com',
      member_email: 'a@example.com',
      member_name: 'Alice',
      start_date: '2026-05-01',
      end_date: '2026-05-08',
    });
    render(<PendingAddRequestsSection pendingAdds={[add]} />);
    const card = document.querySelector('.roster-card');
    expect(card?.className).toContain('type-temp');
  });

  it('maps add_manual to the manual-banded card', () => {
    const add = makeRequest({
      request_id: 'r1',
      type: 'add_manual',
      member_canonical: 'a@example.com',
      member_email: 'a@example.com',
      member_name: 'Alice',
    });
    render(<PendingAddRequestsSection pendingAdds={[add]} />);
    const card = document.querySelector('.roster-card');
    expect(card?.className).toContain('type-manual');
  });
});
