// Field-by-field diff table rendered inside the audit-row `<details>`
// expansion. Three header shapes — Field / Before / After (update),
// Field / After (create), Field / Before (delete) — driven by the
// FieldDiffResult.shape enum returned from computeFieldDiff. Unchanged
// fields are summarised in a trailer so the reader knows the table
// isn't truncated.
//
// Cross-collection rows render transparently: each row's keys are
// derived from its own before+after, so seats / access / requests can
// sit in the same query result without per-entity branching.

import { computeFieldDiff, formatDiffValue } from './summarise';

export interface AuditDiffTableProps {
  before: unknown;
  after: unknown;
}

export function AuditDiffTable({ before, after }: AuditDiffTableProps) {
  const diff = computeFieldDiff(before, after);

  if (diff.shape === 'empty') {
    return <div className="kd-audit-diff-empty">No payload.</div>;
  }
  if (diff.rows.length === 0) {
    return <div className="kd-audit-diff-empty">No field changes detected.</div>;
  }

  const showBefore = diff.shape === 'update' || diff.shape === 'delete';
  const showAfter = diff.shape === 'update' || diff.shape === 'create';

  return (
    <>
      <table className="kd-audit-diff-table" data-testid="audit-diff-table">
        <thead>
          <tr>
            <th scope="col">Field</th>
            {showBefore && <th scope="col">{headerFor('before', diff.shape)}</th>}
            {showAfter && <th scope="col">{headerFor('after', diff.shape)}</th>}
          </tr>
        </thead>
        <tbody>
          {diff.rows.map((row) => (
            <tr key={row.field} data-testid={`audit-diff-row-${row.field}`}>
              <td>
                <code>{row.field}</code>
              </td>
              {showBefore && (
                <td className={cellClass('before', row.kind)}>{formatDiffValue(row.before)}</td>
              )}
              {showAfter && (
                <td className={cellClass('after', row.kind)}>{formatDiffValue(row.after)}</td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      {diff.unchangedCount > 0 && (
        <div className="kd-audit-diff-unchanged" data-testid="audit-diff-unchanged">
          {diff.unchangedCount} unchanged field{diff.unchangedCount === 1 ? '' : 's'} not shown.
        </div>
      )}
    </>
  );
}

function headerFor(side: 'before' | 'after', shape: 'create' | 'update' | 'delete' | 'empty') {
  if (shape === 'create' && side === 'after') return 'After (inserted)';
  if (shape === 'delete' && side === 'before') return 'Before (deleted)';
  return side === 'before' ? 'Before' : 'After';
}

function cellClass(side: 'before' | 'after', kind: 'change' | 'add' | 'remove'): string {
  // 'add' rows have nothing meaningful in the before column; 'remove'
  // rows have nothing meaningful in the after column. Style them as
  // muted so the eye lands on the side that carries data.
  const base = side === 'before' ? 'kd-audit-diff-before' : 'kd-audit-diff-after';
  if (side === 'before' && kind === 'add') return `${base} kd-audit-diff-muted`;
  if (side === 'after' && kind === 'remove') return `${base} kd-audit-diff-muted`;
  return base;
}
