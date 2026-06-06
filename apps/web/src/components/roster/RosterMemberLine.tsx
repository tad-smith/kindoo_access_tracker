// Shared member name/email line for roster cards. Used by both
// <PerGrantRosterCard> (bishopric + stake + ward rosters) and the
// AllSeats inline GrantRowCard so the two surfaces never drift.
//
// Desktop (>480px): `{name} ({email})` inline, exactly as before.
// Mobile (≤480px, via RosterCardList.css): name on line 1 (bold), then
// an `email:` label + email on line 2 — the parentheses hide and the
// `email:` label shows. The no-name fallback renders just the email
// (no parens, no label) on both breakpoints.

interface RosterMemberLineProps {
  name: string | null | undefined;
  email: string;
}

export function RosterMemberLine({ name, email }: RosterMemberLineProps) {
  if (!name) {
    return (
      <span className="roster-email" title={email}>
        {email}
      </span>
    );
  }
  return (
    <>
      <span className="roster-card-name">{name}</span>{' '}
      <span className="roster-card-email-wrap">
        <span className="roster-email-paren">(</span>
        <span className="roster-card-email-label">email:</span>
        <span className="roster-email" title={email}>
          {email}
        </span>
        <span className="roster-email-paren">)</span>
      </span>
    </>
  );
}
