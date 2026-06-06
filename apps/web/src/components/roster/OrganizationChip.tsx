// Organization chip for the Stake Roster card's top line. Renders the
// member's organization name (or "No Organization" when unset).
//
// Two modes:
//   - read-only — a plain chip (`<span>`). Used when the viewer lacks
//     stake app access, or when the rendered grant is a duplicate stake
//     grant (its org is set via the request form, not inline).
//   - editable — a native `<select>` styled as a chip with a leading
//     dropdown-arrow. Choosing an option writes the change immediately
//     via `useSetSeatOrganization` (direct write). Native `<select>`
//     (the same primitive as `components/ui/Select`) keeps the menu
//     keyboard- and mobile-accessible at the 375px viewport without a
//     new Radix dependency, and its `onChange` maps cleanly to the
//     "select → write immediately" contract.
//
// Only the PRIMARY stake grant is editable; the caller computes
// `editable` (stake access AND `grant.isPrimary`) and the resolved
// `orgId` (primary → `seat.organization_id`; duplicate → that
// duplicate's `organization_id`).

import type { Organization } from '@kindoo/shared';
import { organizationName, sortOrganizations } from '../../features/organizations/hooks';
import { useSetSeatOrganization } from '../../features/stake/hooks';
import './OrganizationChip.css';

/** Sentinel `<option>` value for "No Organization" (`<select>` values must be strings). */
const NO_ORG_VALUE = '__none__';

export interface OrganizationChipProps {
  /** Live organizations catalogue (for id→name resolution + the menu). */
  orgs: readonly Organization[];
  /** Resolved org id for the rendered grant; `null` → "No Organization". */
  orgId: string | null;
  /** True iff the inline editor (the `<select>`) should render. */
  editable: boolean;
  /** Canonical email = seat doc id; the mutation target. Required when editable. */
  memberCanonical: string;
}

export function OrganizationChip({
  orgs,
  orgId,
  editable,
  memberCanonical,
}: OrganizationChipProps) {
  const setOrg = useSetSeatOrganization();
  const label = organizationName(orgs, orgId);

  if (!editable) {
    return (
      <span
        className="roster-card-chip roster-org-chip"
        data-testid={`org-chip-${memberCanonical}`}
        data-editable="false"
      >
        <span className="label">Org:</span>
        <span className="roster-org-name">{label}</span>
      </span>
    );
  }

  const value = orgId ?? NO_ORG_VALUE;
  const sorted = sortOrganizations(orgs);

  return (
    <span
      className="roster-card-chip roster-org-chip roster-org-chip--editable"
      data-testid={`org-chip-${memberCanonical}`}
      data-editable="true"
    >
      <span className="label">Org:</span>
      <select
        className="kd-select roster-org-select"
        aria-label={`Set organization for ${memberCanonical}`}
        data-testid={`org-select-${memberCanonical}`}
        value={value}
        disabled={setOrg.isPending}
        onChange={(e) => {
          const next = e.target.value === NO_ORG_VALUE ? null : e.target.value;
          if (next === orgId) return;
          setOrg.mutate({ memberCanonical, organizationId: next });
        }}
      >
        <option value={NO_ORG_VALUE}>No Organization</option>
        {sorted.map((org) => (
          <option key={org.organization_id} value={org.organization_id}>
            {org.name}
          </option>
        ))}
      </select>
    </span>
  );
}
