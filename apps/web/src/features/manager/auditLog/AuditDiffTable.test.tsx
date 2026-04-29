// Component tests for AuditDiffTable. Walks the four shapes (create /
// update / delete / empty) and the special-cased value formatting
// (timestamps, arrays, nullables) that surfaces visually.

import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { AuditDiffTable } from './AuditDiffTable';

describe('<AuditDiffTable />', () => {
  it('renders a "No payload" placeholder when both sides are null', () => {
    render(<AuditDiffTable before={null} after={null} />);
    expect(screen.getByText(/no payload/i)).toBeInTheDocument();
    expect(screen.queryByTestId('audit-diff-table')).not.toBeInTheDocument();
  });

  it('renders "No field changes detected" when before and after are equal', () => {
    render(<AuditDiffTable before={{ scope: 'CO' }} after={{ scope: 'CO' }} />);
    expect(screen.getByText(/no field changes/i)).toBeInTheDocument();
  });

  it('renders create shape with single "After (inserted)" column', () => {
    render(<AuditDiffTable before={null} after={{ scope: 'CO', type: 'auto' }} />);
    const table = screen.getByTestId('audit-diff-table');
    expect(within(table).getByText('Field')).toBeInTheDocument();
    expect(within(table).getByText('After (inserted)')).toBeInTheDocument();
    expect(within(table).queryByText(/^Before/)).not.toBeInTheDocument();
    expect(screen.getByTestId('audit-diff-row-scope')).toBeInTheDocument();
    expect(screen.getByTestId('audit-diff-row-type')).toBeInTheDocument();
  });

  it('renders delete shape with single "Before (deleted)" column', () => {
    render(<AuditDiffTable before={{ scope: 'CO', type: 'auto' }} after={null} />);
    const table = screen.getByTestId('audit-diff-table');
    expect(within(table).getByText('Before (deleted)')).toBeInTheDocument();
    expect(within(table).queryByText(/^After/)).not.toBeInTheDocument();
  });

  it('renders update shape with both columns and only changed rows', () => {
    render(
      <AuditDiffTable
        before={{ scope: 'CO', type: 'auto', member_email: 'alice@example.com' }}
        after={{ scope: 'CO', type: 'manual', member_email: 'alice@example.com' }}
      />,
    );
    const table = screen.getByTestId('audit-diff-table');
    expect(within(table).getByText('Before')).toBeInTheDocument();
    expect(within(table).getByText('After')).toBeInTheDocument();
    expect(screen.getByTestId('audit-diff-row-type')).toBeInTheDocument();
    expect(screen.queryByTestId('audit-diff-row-scope')).not.toBeInTheDocument();
    expect(screen.queryByTestId('audit-diff-row-member_email')).not.toBeInTheDocument();
  });

  it('shows the unchanged-fields trailer with a count', () => {
    render(<AuditDiffTable before={{ a: 1, b: 2, c: 3 }} after={{ a: 1, b: 2, c: 999 }} />);
    expect(screen.getByTestId('audit-diff-unchanged')).toHaveTextContent(/2 unchanged fields/i);
  });

  it('does not show the trailer when zero fields are unchanged', () => {
    render(<AuditDiffTable before={{ a: 1 }} after={{ a: 2 }} />);
    expect(screen.queryByTestId('audit-diff-unchanged')).not.toBeInTheDocument();
  });

  it('renders nullable fields with an "(empty)" marker', () => {
    render(<AuditDiffTable before={{ note: null }} after={{ note: 'filled' }} />);
    const row = screen.getByTestId('audit-diff-row-note');
    expect(within(row).getByText('(empty)')).toBeInTheDocument();
    expect(within(row).getByText('filled')).toBeInTheDocument();
  });

  it('renders ISO-timestamp strings in human-readable form', () => {
    render(
      <AuditDiffTable
        before={{ end_date: '2026-04-28T00:00:00Z' }}
        after={{ end_date: '2026-05-15T00:00:00Z' }}
      />,
    );
    const row = screen.getByTestId('audit-diff-row-end_date');
    expect(within(row).getByText('2026-04-28 00:00:00 UTC')).toBeInTheDocument();
    expect(within(row).getByText('2026-05-15 00:00:00 UTC')).toBeInTheDocument();
  });

  it('renders primitive-array changes as comma-separated lists', () => {
    render(
      <AuditDiffTable before={{ wards: ['CO', 'EN'] }} after={{ wards: ['CO', 'EN', 'CC'] }} />,
    );
    const row = screen.getByTestId('audit-diff-row-wards');
    expect(within(row).getByText('CO, EN')).toBeInTheDocument();
    expect(within(row).getByText('CO, EN, CC')).toBeInTheDocument();
  });

  it('renders nested map changes as JSON', () => {
    render(
      <AuditDiffTable
        before={{ manual_grants: { CO: ['alice@example.com'] } }}
        after={{ manual_grants: { CO: ['alice@example.com', 'bob@example.com'] } }}
      />,
    );
    const row = screen.getByTestId('audit-diff-row-manual_grants');
    const cells = row.querySelectorAll('td');
    // Three cells: field name code, before, after.
    expect(cells[1]?.textContent).toBe('{"CO":["alice@example.com"]}');
    expect(cells[2]?.textContent).toBe('{"CO":["alice@example.com","bob@example.com"]}');
  });

  it('renders cross-collection rows with disjoint key sets transparently', () => {
    // A seats-shaped before vs an access-shaped after.
    render(
      <AuditDiffTable
        before={{ member_email: 'alice@example.com', scope: 'CO' }}
        after={{ manual_grants: { CO: ['alice@example.com'] } }}
      />,
    );
    expect(screen.getByTestId('audit-diff-row-member_email')).toBeInTheDocument();
    expect(screen.getByTestId('audit-diff-row-scope')).toBeInTheDocument();
    expect(screen.getByTestId('audit-diff-row-manual_grants')).toBeInTheDocument();
  });
});
