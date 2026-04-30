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

  it('renders ISO-timestamp strings in stake-local form', () => {
    render(
      <AuditDiffTable
        before={{ end_date: '2026-04-28T00:00:00Z' }}
        after={{ end_date: '2026-05-15T00:00:00Z' }}
        timezone="UTC"
      />,
    );
    const row = screen.getByTestId('audit-diff-row-end_date');
    expect(within(row).getByText('2026-04-28 12:00 am')).toBeInTheDocument();
    expect(within(row).getByText('2026-05-15 12:00 am')).toBeInTheDocument();
  });

  it('renders primitive-array changes as comma-separated lists', () => {
    render(
      <AuditDiffTable before={{ wards: ['CO', 'EN'] }} after={{ wards: ['CO', 'EN', 'CC'] }} />,
    );
    const row = screen.getByTestId('audit-diff-row-wards');
    expect(within(row).getByText('CO, EN')).toBeInTheDocument();
    expect(within(row).getByText('CO, EN, CC')).toBeInTheDocument();
  });

  it('flattens nested manual_grants into per-scope rows', () => {
    render(
      <AuditDiffTable
        before={{ manual_grants: { CO: ['alice@example.com'] } }}
        after={{ manual_grants: { CO: ['alice@example.com', 'bob@example.com'] } }}
      />,
    );
    // The flatten produces a per-scope row keyed `manual_grants[CO]`,
    // not a single JSON dump.
    const row = screen.getByTestId('audit-diff-row-manual_grants[CO]');
    expect(row).toBeInTheDocument();
    expect(screen.queryByTestId('audit-diff-row-manual_grants')).toBeNull();
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
    // manual_grants flattens to a per-scope row; the bare-name row
    // shouldn't exist anymore.
    expect(screen.getByTestId('audit-diff-row-manual_grants[CO]')).toBeInTheDocument();
    expect(screen.queryByTestId('audit-diff-row-manual_grants')).toBeNull();
  });

  describe('cell coloring (red/green diff convention)', () => {
    it('paints the before cell with kd-audit-diff-before (red)', () => {
      render(<AuditDiffTable before={{ scope: 'CO' }} after={{ scope: 'EN' }} />);
      const row = screen.getByTestId('audit-diff-row-scope');
      const cells = row.querySelectorAll('td');
      // Cells: 0=field name code, 1=before, 2=after.
      expect(cells[1]?.className).toContain('kd-audit-diff-before');
      expect(cells[1]?.className).not.toContain('kd-audit-diff-muted');
    });

    it('paints the after cell with kd-audit-diff-after (green)', () => {
      render(<AuditDiffTable before={{ scope: 'CO' }} after={{ scope: 'EN' }} />);
      const row = screen.getByTestId('audit-diff-row-scope');
      const cells = row.querySelectorAll('td');
      expect(cells[2]?.className).toContain('kd-audit-diff-after');
      expect(cells[2]?.className).not.toContain('kd-audit-diff-muted');
    });

    it('mutes the before cell on an "add" row (key only in after)', () => {
      // The before column shows "(absent)" for an added field — paint
      // it muted so the eye lands on the after side.
      render(<AuditDiffTable before={{ existing: 1 }} after={{ existing: 1, added: 'x' }} />);
      const row = screen.getByTestId('audit-diff-row-added');
      const cells = row.querySelectorAll('td');
      expect(cells[1]?.className).toContain('kd-audit-diff-muted');
      expect(cells[2]?.className).not.toContain('kd-audit-diff-muted');
    });

    it('mutes the after cell on a "remove" row (key only in before)', () => {
      render(<AuditDiffTable before={{ existing: 1, removed: 'x' }} after={{ existing: 1 }} />);
      const row = screen.getByTestId('audit-diff-row-removed');
      const cells = row.querySelectorAll('td');
      expect(cells[1]?.className).not.toContain('kd-audit-diff-muted');
      expect(cells[2]?.className).toContain('kd-audit-diff-muted');
    });

    it('paints the after-only cell on a "create" row green (no muted class)', () => {
      render(<AuditDiffTable before={null} after={{ scope: 'CO' }} />);
      const row = screen.getByTestId('audit-diff-row-scope');
      const cells = row.querySelectorAll('td');
      // Two cells: field name, after.
      expect(cells[1]?.className).toContain('kd-audit-diff-after');
      expect(cells[1]?.className).not.toContain('kd-audit-diff-muted');
    });

    it('paints the before-only cell on a "delete" row red (no muted class)', () => {
      render(<AuditDiffTable before={{ scope: 'CO' }} after={null} />);
      const row = screen.getByTestId('audit-diff-row-scope');
      const cells = row.querySelectorAll('td');
      expect(cells[1]?.className).toContain('kd-audit-diff-before');
      expect(cells[1]?.className).not.toContain('kd-audit-diff-muted');
    });
  });

  describe('bookkeeping field exclusion', () => {
    it('hides lastActor changes from the visible diff', () => {
      render(
        <AuditDiffTable
          before={{ scope: 'CO', lastActor: { canonical: 'a@x.com', email: 'a@x.com' } }}
          after={{ scope: 'CO', lastActor: { canonical: 'b@x.com', email: 'b@x.com' } }}
        />,
      );
      // No diff rows at all — only bookkeeping changed.
      expect(screen.queryByTestId('audit-diff-row-lastActor')).not.toBeInTheDocument();
      expect(screen.queryByTestId('audit-diff-row-scope')).not.toBeInTheDocument();
      expect(screen.getByText(/no field changes/i)).toBeInTheDocument();
    });

    it('hides timestamp metadata fields (created_at, last_modified_at, etc)', () => {
      render(
        <AuditDiffTable
          before={null}
          after={{
            scope: 'CO',
            type: 'auto',
            lastActor: { canonical: 'a@x.com' },
            created_at: '2026-04-28T00:00:00Z',
            created_by: 'a@x.com',
            last_modified_at: '2026-04-28T00:00:00Z',
            last_modified_by: 'a@x.com',
            added_at: '2026-04-28T00:00:00Z',
            added_by: 'a@x.com',
            granted_at: '2026-04-28T00:00:00Z',
            granted_by: 'a@x.com',
            detected_at: '2026-04-28T00:00:00Z',
            updated_at: '2026-04-28T00:00:00Z',
          }}
        />,
      );
      // Only user-visible fields render.
      expect(screen.getByTestId('audit-diff-row-scope')).toBeInTheDocument();
      expect(screen.getByTestId('audit-diff-row-type')).toBeInTheDocument();
      // Every bookkeeping field hidden.
      expect(screen.queryByTestId('audit-diff-row-lastActor')).not.toBeInTheDocument();
      expect(screen.queryByTestId('audit-diff-row-created_at')).not.toBeInTheDocument();
      expect(screen.queryByTestId('audit-diff-row-created_by')).not.toBeInTheDocument();
      expect(screen.queryByTestId('audit-diff-row-last_modified_at')).not.toBeInTheDocument();
      expect(screen.queryByTestId('audit-diff-row-last_modified_by')).not.toBeInTheDocument();
      expect(screen.queryByTestId('audit-diff-row-added_at')).not.toBeInTheDocument();
      expect(screen.queryByTestId('audit-diff-row-added_by')).not.toBeInTheDocument();
      expect(screen.queryByTestId('audit-diff-row-granted_at')).not.toBeInTheDocument();
      expect(screen.queryByTestId('audit-diff-row-granted_by')).not.toBeInTheDocument();
      expect(screen.queryByTestId('audit-diff-row-detected_at')).not.toBeInTheDocument();
      expect(screen.queryByTestId('audit-diff-row-updated_at')).not.toBeInTheDocument();
    });
  });
});
