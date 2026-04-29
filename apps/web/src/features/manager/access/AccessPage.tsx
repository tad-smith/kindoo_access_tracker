// Manager Access page (read-only in Phase 5). Per `firebase-schema.md`
// §4.5, the Access collection is jointly owned: importer-managed
// `importer_callings` are read-only here; manager-managed
// `manual_grants` get write actions in Phase 7.
//
// One card per user with the two ownership stripes visually split:
// importer block on top (light auto-row tint), manual block below
// (warm tint). Empty maps collapse silently.

import { useMemo, useState } from 'react';
import type { Access } from '@kindoo/shared';
import { useAccessList } from './hooks';
import { LoadingSpinner } from '../../../lib/render/LoadingSpinner';
import { EmptyState } from '../../../lib/render/EmptyState';
import { Select } from '../../../components/ui/Select';
import { Badge } from '../../../components/ui/Badge';

export function AccessPage() {
  const access = useAccessList();
  const [scopeFilter, setScopeFilter] = useState<string>('');

  const all = useMemo(() => access.data ?? [], [access.data]);

  // Build the scope dropdown from every scope mentioned in any user's
  // importer_callings or manual_grants.
  const scopes = useMemo(() => {
    const seen = new Set<string>();
    for (const a of all) {
      for (const k of Object.keys(a.importer_callings ?? {})) seen.add(k);
      for (const k of Object.keys(a.manual_grants ?? {})) seen.add(k);
    }
    const list = Array.from(seen);
    return list.sort((a, b) => {
      if (a === 'stake') return -1;
      if (b === 'stake') return 1;
      return a.localeCompare(b);
    });
  }, [all]);

  // Filter rows by scope: a user-row is included if either side has a
  // grant for the selected scope.
  const filtered = useMemo(() => {
    if (!scopeFilter) return all;
    return all.filter(
      (a) =>
        (a.importer_callings?.[scopeFilter]?.length ?? 0) > 0 ||
        (a.manual_grants?.[scopeFilter]?.length ?? 0) > 0,
    );
  }, [all, scopeFilter]);

  // Stable display order: by member_email A-Z, then canonical for tie-breaking.
  const sorted = useMemo(
    () =>
      [...filtered].sort((a, b) => {
        const aKey = a.member_email || a.member_canonical;
        const bKey = b.member_email || b.member_canonical;
        return aKey.localeCompare(bKey);
      }),
    [filtered],
  );

  const manualCount = sorted.reduce(
    (acc, a) => acc + Object.values(a.manual_grants ?? {}).reduce((s, list) => s + list.length, 0),
    0,
  );

  return (
    <section>
      <h1>Access</h1>
      <p className="kd-page-subtitle">
        Who has app access. Importer-sourced rows reflect LCR truth; manual rows are direct grants
        by a Kindoo Manager. Phase 5 is read-only; manage manual rows from Phase 7.
      </p>

      <div className="kd-filter-row">
        <label>
          Scope:
          <Select value={scopeFilter} onChange={(e) => setScopeFilter(e.target.value)}>
            <option value="">All</option>
            {scopes.map((s) => (
              <option key={s} value={s}>
                {s === 'stake' ? 'Stake' : s}
              </option>
            ))}
          </Select>
        </label>
        <span style={{ alignSelf: 'center' }}>
          {sorted.length} user{sorted.length === 1 ? '' : 's'} ({manualCount} manual grant
          {manualCount === 1 ? '' : 's'})
        </span>
      </div>

      {access.isLoading || access.data === undefined ? (
        <LoadingSpinner />
      ) : sorted.length === 0 ? (
        <EmptyState message="No access rows. Run the importer or add a manual grant (Phase 7)." />
      ) : (
        <div className="kd-access-cards" data-testid="access-cards">
          {sorted.map((a) => (
            <AccessCard key={a.member_canonical} access={a} scopeFilter={scopeFilter} />
          ))}
        </div>
      )}
    </section>
  );
}

interface AccessCardProps {
  access: Access;
  scopeFilter: string;
}

function AccessCard({ access, scopeFilter }: AccessCardProps) {
  const importerScopes = Object.entries(access.importer_callings ?? {})
    .filter(([scope, callings]) => (!scopeFilter || scope === scopeFilter) && callings.length > 0)
    .sort(([a], [b]) => (a === 'stake' ? -1 : b === 'stake' ? 1 : a.localeCompare(b)));
  const manualScopes = Object.entries(access.manual_grants ?? {})
    .filter(([scope, grants]) => (!scopeFilter || scope === scopeFilter) && grants.length > 0)
    .sort(([a], [b]) => (a === 'stake' ? -1 : b === 'stake' ? 1 : a.localeCompare(b)));

  return (
    <div className="kd-access-card" data-testid={`access-card-${access.member_canonical}`}>
      <div className="kd-access-card-header">
        {access.member_name ? <strong>{access.member_name}</strong> : null}
        <span className="roster-email" title={access.member_email}>
          {access.member_email}
        </span>
      </div>

      {importerScopes.length > 0 ? (
        <div className="kd-access-section importer" data-testid="access-section-importer">
          <div className="kd-access-section-header">
            <Badge variant="auto">importer</Badge> from LCR (read-only)
          </div>
          {importerScopes.map(([scope, callings]) => (
            <div key={`imp-${scope}`}>
              <span className="roster-card-chip roster-card-scope">
                <code>{scope === 'stake' ? 'stake' : scope}</code>
              </span>
              <ul className="kd-access-grants">
                {callings.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      ) : null}

      {manualScopes.length > 0 ? (
        <div className="kd-access-section manual" data-testid="access-section-manual">
          <div className="kd-access-section-header">
            <Badge variant="manual">manual</Badge> manager-granted (Phase 7 will add edit
            affordances)
          </div>
          {manualScopes.map(([scope, grants]) => (
            <div key={`man-${scope}`}>
              <span className="roster-card-chip roster-card-scope">
                <code>{scope === 'stake' ? 'stake' : scope}</code>
              </span>
              <ul className="kd-access-grants">
                {grants.map((g) => (
                  <li key={g.grant_id}>{g.reason}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
