// Layout coverage for <PerGrantRosterCard>. The per-grant roster card
// renders a two-line header: badges + actions on the first row, the
// member name/email on its own second row. The AllSeats GrantRowCard
// uses the same two-line header (covered by AllSeatsPage.test.tsx),
// sharing the `roster-card--two-line` modifier so the two surfaces
// stay visually consistent.
//
// The Edit / Removal affordances subscribe to Firestore + principal +
// active-stake context; this test stubs them to plain markers because
// only the card's row grouping is under test here.

import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { PerGrantRosterCard } from './PerGrantRosterCard';
import type { GrantView } from '../../lib/grants';
import type { Seat } from '@kindoo/shared';

vi.mock('../../features/requests/components/EditSeatAffordance', () => ({
  EditSeatAffordance: (_props: Record<string, unknown>) => (
    <button data-testid="edit-affordance">Edit</button>
  ),
}));
vi.mock('../../features/requests/components/RemovalAffordance', () => ({
  RemovalAffordance: (_props: Record<string, unknown>) => (
    <button data-testid="remove-affordance">Remove</button>
  ),
}));

const seat = {
  member_name: 'Member One',
  member_email: 'member.one@example.com',
  member_canonical: 'memberone@example.com',
} as Seat;

const grant: GrantView = {
  type: 'manual',
  scope: 'ward/CO',
  callings: [],
  building_names: ['Building A'],
  reason: 'Custodial access',
  kindoo_site_id: null,
  isPrimary: true,
  isParallelSite: false,
  duplicateIndex: -1,
  hasSameScopeDuplicates: false,
};

function renderCard(overrides: Partial<Parameters<typeof PerGrantRosterCard>[0]> = {}) {
  return render(
    <PerGrantRosterCard
      seat={seat}
      grant={grant}
      canEdit={false}
      canRemove={false}
      isPendingRemoval={false}
      wards={[]}
      sites={[]}
      {...overrides}
    />,
  );
}

describe('PerGrantRosterCard layout', () => {
  it('renders badges and actions on the first line, member on the second', () => {
    const { container } = renderCard({ canEdit: true, canRemove: true });

    const card = container.querySelector('.roster-card');
    expect(card).not.toBeNull();
    expect(card?.classList.contains('roster-card--two-line')).toBe(true);

    const line1 = card?.querySelector('.roster-card-line1');
    expect(line1).not.toBeNull();
    // First line carries the type badge and the action buttons...
    expect(line1?.querySelector('.roster-card-badges')).not.toBeNull();
    expect(line1?.querySelector('.roster-card-actions')).not.toBeNull();
    // ...but NOT the member name/email.
    expect(line1?.querySelector('.roster-card-member')).toBeNull();
  });

  it('places the member name and email on the dedicated second line', () => {
    const { container } = renderCard();

    const memberLine = container.querySelector('.roster-card-member-line');
    expect(memberLine).not.toBeNull();
    expect(memberLine?.querySelector('.roster-card-member')).not.toBeNull();
    expect(memberLine?.textContent).toContain('Member One');
    expect(memberLine?.textContent).toContain('member.one@example.com');
  });

  it('keeps the member line present even when there are no actions', () => {
    const { container } = renderCard({ canEdit: false, canRemove: false });

    const line1 = container.querySelector('.roster-card-line1');
    expect(line1?.querySelector('.roster-card-actions')).toBeNull();
    expect(container.querySelector('.roster-card-member-line .roster-card-member')).not.toBeNull();
  });
});
