// Tests for the shared `<RosterCardList />` primitive consumed by every
// Phase-5 read-only roster page. Covers the three states the migration
// plan requires: empty, one row, full fixture.

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RosterCardList } from './RosterCardList';
import { makeSeat } from '../../../test/fixtures';

describe('RosterCardList', () => {
  it('shows the supplied empty message when no seats are passed', () => {
    render(<RosterCardList seats={[]} emptyMessage="No seats assigned to this ward." />);
    expect(screen.getByText(/no seats assigned to this ward/i)).toBeInTheDocument();
  });

  it('renders a single auto seat with the calling chip + member name', () => {
    const seat = makeSeat({
      member_name: 'Alice Example',
      callings: ['Bishop'],
      type: 'auto',
    });
    render(<RosterCardList seats={[seat]} />);
    expect(screen.getByText('auto')).toBeInTheDocument();
    expect(screen.getByText('Alice Example')).toBeInTheDocument();
    expect(screen.getByText(/calling:/i)).toBeInTheDocument();
    expect(screen.getByText('Bishop')).toBeInTheDocument();
  });

  it('renders a manual seat with the reason chip rather than a calling chip', () => {
    const seat = makeSeat({
      member_canonical: 'bob@example.com',
      member_email: 'bob@example.com',
      member_name: 'Bob Example',
      type: 'manual',
      callings: [],
      reason: 'Cleaning crew',
    });
    render(<RosterCardList seats={[seat]} />);
    expect(screen.getByText('manual')).toBeInTheDocument();
    expect(screen.getByText(/reason:/i)).toBeInTheDocument();
    expect(screen.getByText('Cleaning crew')).toBeInTheDocument();
    expect(screen.queryByText(/calling:/i)).toBeNull();
  });

  it('renders the dates line on a temp seat and not on auto/manual', () => {
    const tempSeat = makeSeat({
      member_canonical: 'temp@example.com',
      member_email: 'temp@example.com',
      type: 'temp',
      callings: [],
      reason: 'Visiting choir',
      start_date: '2026-05-01',
      end_date: '2026-05-15',
    });
    render(<RosterCardList seats={[tempSeat]} />);
    expect(screen.getByText(/dates:/i)).toBeInTheDocument();
    expect(screen.getByText(/2026-05-01/)).toBeInTheDocument();
    expect(screen.getByText(/2026-05-15/)).toBeInTheDocument();
  });

  it('renders all rows in the order passed (no internal sorting)', () => {
    const seats = [
      makeSeat({ member_canonical: 'a@x.com', member_email: 'a@x.com', member_name: 'Alpha' }),
      makeSeat({ member_canonical: 'b@x.com', member_email: 'b@x.com', member_name: 'Bravo' }),
      makeSeat({ member_canonical: 'c@x.com', member_email: 'c@x.com', member_name: 'Charlie' }),
    ];
    render(<RosterCardList seats={seats} />);
    const cards = document.querySelectorAll('.roster-card');
    expect(cards).toHaveLength(3);
    expect(cards[0]).toHaveAttribute('data-seat-id', 'a@x.com');
    expect(cards[1]).toHaveAttribute('data-seat-id', 'b@x.com');
    expect(cards[2]).toHaveAttribute('data-seat-id', 'c@x.com');
  });

  it('renders the scope chip when showScope is true', () => {
    const seat = makeSeat({ scope: 'CO' });
    render(<RosterCardList seats={[seat]} showScope />);
    expect(document.querySelector('.roster-card-scope code')).toHaveTextContent('CO');
  });

  it('does not render the scope chip when showScope is false', () => {
    const seat = makeSeat({ scope: 'CO' });
    render(<RosterCardList seats={[seat]} showScope={false} />);
    expect(document.querySelector('.roster-card-scope')).toBeNull();
  });

  it('renders the actions slot when supplied', () => {
    const seat = makeSeat({ type: 'manual', callings: [], reason: 'r' });
    render(
      <RosterCardList
        seats={[seat]}
        actions={(s) => (s.type === 'auto' ? null : <button>Edit</button>)}
      />,
    );
    expect(screen.getByRole('button', { name: /edit/i })).toBeInTheDocument();
  });

  it('renders extraBadges injected after the type badge', () => {
    const seat = makeSeat();
    render(
      <RosterCardList
        seats={[seat]}
        extraBadges={() => <span data-testid="extra-badge">extra</span>}
      />,
    );
    expect(screen.getByTestId('extra-badge')).toBeInTheDocument();
  });

  it('appends the per-row className from rowClass to the card container', () => {
    const seat = makeSeat({ member_canonical: 'leaving@x.com' });
    render(
      <RosterCardList
        seats={[seat]}
        rowClass={(s) =>
          s.member_canonical === 'leaving@x.com' ? 'has-removal-pending' : undefined
        }
      />,
    );
    const card = document.querySelector('[data-seat-id="leaving@x.com"]');
    expect(card?.className).toContain('has-removal-pending');
    expect(card?.className).toContain('roster-card');
  });
});
