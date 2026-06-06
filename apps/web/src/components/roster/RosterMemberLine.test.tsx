// Coverage for the shared <RosterMemberLine>. jsdom does not evaluate
// media queries, so these assert on DOM presence (both the desktop
// parens and the mobile `email:` label exist in the markup; CSS toggles
// their visibility per breakpoint) rather than computed visibility.

import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { RosterMemberLine } from './RosterMemberLine';

describe('RosterMemberLine', () => {
  it('renders the bold name plus the email when a name is present', () => {
    const { container } = render(
      <RosterMemberLine name="Member One" email="member.one@example.com" />,
    );

    const name = container.querySelector('.roster-card-name');
    expect(name?.textContent).toBe('Member One');

    const email = container.querySelector('.roster-email');
    expect(email?.textContent).toBe('member.one@example.com');
    expect(email?.getAttribute('title')).toBe('member.one@example.com');
  });

  it('carries both the desktop parens and the mobile email: label', () => {
    const { container } = render(
      <RosterMemberLine name="Member One" email="member.one@example.com" />,
    );

    // Desktop form: literal parentheses wrap the email (CSS hides them ≤480px).
    const parens = container.querySelectorAll('.roster-email-paren');
    expect(parens).toHaveLength(2);
    expect(parens[0]?.textContent).toBe('(');
    expect(parens[1]?.textContent).toBe(')');

    // Mobile form: an `email:` label matching the card's other field
    // labels (CSS hides it >480px).
    const label = container.querySelector('.roster-card-email-label');
    expect(label).not.toBeNull();
    expect(label?.textContent).toBe('email:');
  });

  it('falls back to a bare email with no name, parens, or label', () => {
    const { container } = render(<RosterMemberLine name={null} email="bare@example.com" />);

    expect(container.querySelector('.roster-card-name')).toBeNull();
    expect(container.querySelector('.roster-email-paren')).toBeNull();
    expect(container.querySelector('.roster-card-email-label')).toBeNull();

    const email = container.querySelector('.roster-email');
    expect(email?.textContent).toBe('bare@example.com');
    expect(email?.getAttribute('title')).toBe('bare@example.com');
  });

  it('treats an empty-string name as the no-name fallback', () => {
    const { container } = render(<RosterMemberLine name="" email="bare@example.com" />);

    expect(container.querySelector('.roster-card-name')).toBeNull();
    expect(container.querySelector('.roster-card-email-label')).toBeNull();
    expect(container.querySelector('.roster-email')?.textContent).toBe('bare@example.com');
  });
});
