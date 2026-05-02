// Manager Access page (Phase 7 wires writes). Per `firebase-schema.md`
// §4.5, the Access collection is jointly owned: importer-managed
// `importer_callings` are read-only here; manager-managed
// `manual_grants` get add/delete affordances.
//
// One card per user with the two ownership stripes visually split:
// importer block on top (light auto-row tint), manual block below
// (warm tint). Empty maps collapse silently.
//
// Phase 7 additions:
//   - "Add manual access" form at the page foot.
//   - Per-grant Delete button on manual rows (with confirm dialog).

import { useEffect, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import type { Access, ManualGrant } from '@kindoo/shared';
import {
  useAccessList,
  useAddManualGrantMutation,
  useDeleteManualGrantMutation,
  useStakeCallingTemplates,
  useWardCallingTemplates,
} from './hooks';
import {
  buildSheetOrderLookup,
  compareAccessForCard,
  compareScopeBand,
  lookupSheetOrder,
  type SheetOrderLookup,
} from './sort';
import { useStakeWards } from '../dashboard/hooks';
import { usePrincipal } from '../../../lib/principal';
import { STAKE_ID } from '../../../lib/constants';
import { LoadingSpinner } from '../../../lib/render/LoadingSpinner';
import { EmptyState } from '../../../lib/render/EmptyState';
import { Select } from '../../../components/ui/Select';
import { Input } from '../../../components/ui/Input';
import { Button } from '../../../components/ui/Button';
import { Badge } from '../../../components/ui/Badge';
import { Dialog } from '../../../components/ui/Dialog';
import { toast } from '../../../lib/store/toast';

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function AccessPage() {
  const access = useAccessList();
  const wards = useStakeWards();
  const stakeTemplates = useStakeCallingTemplates();
  const wardTemplates = useWardCallingTemplates();
  const principal = usePrincipal();
  // (scope, calling) → sheet_order. Drives the desktop table view's
  // per-row sort. Card view continues to use the doc-level
  // `sort_order` denormalised by the importer (correct under the
  // operator's no-cross-scope-overlap assumption).
  const sheetOrderLookup = useMemo<SheetOrderLookup>(
    () =>
      buildSheetOrderLookup({
        stakeTemplates: stakeTemplates.data ?? [],
        wardTemplates: wardTemplates.data ?? [],
        wardCodes: (wards.data ?? []).map((w) => w.ward_code),
      }),
    [stakeTemplates.data, wardTemplates.data, wards.data],
  );
  const [scopeFilter, setScopeFilter] = useState<string>('');
  const deleteMutation = useDeleteManualGrantMutation();
  const [pendingDelete, setPendingDelete] = useState<{
    canonical: string;
    scope: string;
    grant: ManualGrant;
  } | null>(null);

  const all = useMemo(() => access.data ?? [], [access.data]);

  // Scope dropdown reflects the principal's authority:
  //   - manager (full stake) → all wards + 'stake'
  //   - stake claim only → 'stake'
  //   - bishopric only → just those wards
  // Sort: 'stake' first, wards alphabetical.
  const scopes = useMemo(() => {
    const seen = new Set<string>();
    if (principal.managerStakes.includes(STAKE_ID)) {
      seen.add('stake');
      for (const w of wards.data ?? []) seen.add(w.ward_code);
    } else {
      if (principal.stakeMemberStakes.includes(STAKE_ID)) seen.add('stake');
      for (const w of principal.bishopricWards[STAKE_ID] ?? []) seen.add(w);
    }
    const list = Array.from(seen);
    return list.sort((a, b) => {
      if (a === 'stake') return -1;
      if (b === 'stake') return 1;
      return a.localeCompare(b);
    });
  }, [principal.managerStakes, principal.stakeMemberStakes, principal.bishopricWards, wards.data]);

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

  // Card view order: scope band (stake first, wards alpha) → doc-level
  // `sort_order` ascending (null → bottom) → alpha by `member_email`.
  // See `./sort.ts` for the comparator + the no-overlap rationale on
  // using the doc-level `sort_order` directly.
  const sorted = useMemo(() => [...filtered].sort(compareAccessForCard), [filtered]);

  const manualCount = sorted.reduce(
    (acc, a) => acc + Object.values(a.manual_grants ?? {}).reduce((s, list) => s + list.length, 0),
    0,
  );

  async function confirmDelete() {
    if (!pendingDelete) return;
    try {
      await deleteMutation.mutateAsync({
        member_canonical: pendingDelete.canonical,
        scope: pendingDelete.scope,
        grant: pendingDelete.grant,
      });
      toast('Manual grant removed.', 'success');
      setPendingDelete(null);
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  }

  const [addOpen, setAddOpen] = useState(false);

  return (
    <section>
      <h1>Access</h1>
      <p className="kd-page-subtitle">
        Who has app access. Importer-sourced rows reflect LCR truth; manual rows are direct grants
        by a Kindoo Manager.
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
        <span className="kd-filter-summary">
          {sorted.length} user{sorted.length === 1 ? '' : 's'} ({manualCount} manual grant
          {manualCount === 1 ? '' : 's'})
        </span>
        <Button
          onClick={() => setAddOpen(true)}
          data-testid="access-add-manual-button"
          className="kd-filter-row-action"
        >
          Add Manual Access
        </Button>
      </div>

      {access.isLoading || access.data === undefined ? (
        <LoadingSpinner />
      ) : sorted.length === 0 ? (
        <EmptyState message='No access rows. Run the importer or add a manual grant via "Add Manual Access".' />
      ) : (
        <>
          <AccessTable
            users={sorted}
            scopeFilter={scopeFilter}
            sheetOrderLookup={sheetOrderLookup}
            onDeleteRequest={(canonical, scope, grant) =>
              setPendingDelete({ canonical, scope, grant })
            }
          />
          <div className="kd-access-cards kd-responsive-cards-phone" data-testid="access-cards">
            {sorted.map((a) => (
              <AccessCard
                key={a.member_canonical}
                access={a}
                scopeFilter={scopeFilter}
                onDeleteRequest={(scope, grant) =>
                  setPendingDelete({ canonical: a.member_canonical, scope, grant })
                }
              />
            ))}
          </div>
        </>
      )}

      <AddManualGrantDialog open={addOpen} onClose={() => setAddOpen(false)} />

      <Dialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
        title="Remove manual access?"
        description={
          pendingDelete
            ? `Remove the "${pendingDelete.grant.reason}" grant for ${pendingDelete.scope === 'stake' ? 'the Stake' : pendingDelete.scope}?`
            : 'Remove this manual access?'
        }
      >
        <Dialog.Footer>
          <Dialog.CancelButton>Cancel</Dialog.CancelButton>
          <Button variant="danger" onClick={confirmDelete} disabled={deleteMutation.isPending}>
            {deleteMutation.isPending ? 'Removing…' : 'Remove'}
          </Button>
        </Dialog.Footer>
      </Dialog>
    </section>
  );
}

// Desktop table view — one row per (scope, calling/reason, email,
// source) tuple, mirroring the Apps Script Access.html column shape.
// The card list above renders the same data grouped per-user; CSS
// picks which view is visible at 899px.

interface AccessTableRow {
  canonical: string;
  email: string;
  scope: string;
  calling: string;
  source: 'importer' | 'manual';
  /** Set only when source === 'manual'; carries the grant for delete. */
  grant?: ManualGrant;
}

function flattenAccess(
  users: readonly Access[],
  scopeFilter: string,
  sheetOrderLookup: SheetOrderLookup,
): AccessTableRow[] {
  const rows: AccessTableRow[] = [];
  for (const u of users) {
    for (const [scope, callings] of Object.entries(u.importer_callings ?? {})) {
      if (scopeFilter && scope !== scopeFilter) continue;
      for (const calling of callings) {
        rows.push({
          canonical: u.member_canonical,
          email: u.member_email,
          scope,
          calling,
          source: 'importer',
        });
      }
    }
    for (const [scope, grants] of Object.entries(u.manual_grants ?? {})) {
      if (scopeFilter && scope !== scopeFilter) continue;
      for (const g of grants) {
        rows.push({
          canonical: u.member_canonical,
          email: u.member_email,
          scope,
          calling: g.reason,
          source: 'manual',
          grant: g,
        });
      }
    }
  }
  // Sort: scope band (stake first, then wards alpha) → per-row
  // sheet_order from the calling-template lookup → email.
  // Manual-grant rows have no template (their `calling` field carries
  // a free-text reason) so they fall through to `+Infinity` and land
  // at the bottom of their scope band.
  rows.sort((a, b) => {
    const scopeCmp = compareScopeBand(a.scope, b.scope);
    if (scopeCmp !== 0) return scopeCmp;
    const aOrder = lookupSheetOrder(sheetOrderLookup, a.scope, a.calling);
    const bOrder = lookupSheetOrder(sheetOrderLookup, b.scope, b.calling);
    if (aOrder !== bOrder) return aOrder - bOrder;
    if (a.calling !== b.calling) return a.calling.localeCompare(b.calling);
    return a.email.localeCompare(b.email);
  });
  return rows;
}

interface AccessTableProps {
  users: readonly Access[];
  scopeFilter: string;
  sheetOrderLookup: SheetOrderLookup;
  onDeleteRequest: (canonical: string, scope: string, grant: ManualGrant) => void;
}

function AccessTable({ users, scopeFilter, sheetOrderLookup, onDeleteRequest }: AccessTableProps) {
  const rows = useMemo(
    () => flattenAccess(users, scopeFilter, sheetOrderLookup),
    [users, scopeFilter, sheetOrderLookup],
  );
  return (
    <table className="kd-access-table kd-responsive-table-desktop" data-testid="access-table">
      <thead>
        <tr>
          <th>Scope</th>
          <th>Calling / reason</th>
          <th>Email</th>
          <th>Source</th>
          <th className="kd-access-table-actions">Actions</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={`${r.canonical}|${r.scope}|${r.source}|${r.calling}|${i}`}>
            <td>
              <code>{r.scope}</code>
            </td>
            <td>{r.calling}</td>
            <td>
              <span className="roster-email" title={r.email}>
                {r.email}
              </span>
            </td>
            <td>
              {r.source === 'manual' ? (
                <Badge variant="manual">manual</Badge>
              ) : (
                <Badge variant="default">importer</Badge>
              )}
            </td>
            <td className="kd-access-table-actions">
              {r.source === 'manual' && r.grant ? (
                <Button
                  variant="danger"
                  onClick={() => onDeleteRequest(r.canonical, r.scope, r.grant!)}
                  data-testid={`access-table-delete-${r.canonical}-${r.grant.grant_id}`}
                >
                  Delete
                </Button>
              ) : null}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

interface AccessCardProps {
  access: Access;
  scopeFilter: string;
  onDeleteRequest: (scope: string, grant: ManualGrant) => void;
}

function AccessCard({ access, scopeFilter, onDeleteRequest }: AccessCardProps) {
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
            <Badge variant="default">importer</Badge> from LCR (read-only)
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
            <Badge variant="manual">manual</Badge> manager-granted
          </div>
          {manualScopes.map(([scope, grants]) => (
            <div key={`man-${scope}`}>
              <span className="roster-card-chip roster-card-scope">
                <code>{scope === 'stake' ? 'stake' : scope}</code>
              </span>
              <ul className="kd-access-grants">
                {grants.map((g) => (
                  <li key={g.grant_id}>
                    {g.reason}{' '}
                    <Button
                      variant="danger"
                      onClick={() => onDeleteRequest(scope, g)}
                      data-testid={`access-grant-delete-${access.member_canonical}-${g.grant_id}`}
                    >
                      Delete
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

const addManualSchema = z.object({
  member_email: z.string().trim().min(1).email('Must be a valid email.'),
  member_name: z.string().trim().min(1, 'Name is required.'),
  scope: z.string().trim().min(1, 'Scope is required.'),
  reason: z.string().trim().min(1, 'Reason is required.'),
});
type AddManualForm = z.infer<typeof addManualSchema>;

interface AddManualGrantDialogProps {
  open: boolean;
  onClose: () => void;
}

function AddManualGrantDialog({ open, onClose }: AddManualGrantDialogProps) {
  const mutation = useAddManualGrantMutation();
  // Form scope dropdown is data-driven: 'stake' plus one option per
  // configured ward in `stakes/{stakeId}/wards`. A grant against a
  // ward that doesn't exist in this stake is non-operational; the
  // dropdown enforces that at the UX layer.
  const wards = useStakeWards();
  const wardsLoading = wards.isLoading || wards.data === undefined;
  const wardOptions = useMemo(
    () => [...(wards.data ?? [])].map((w) => w.ward_code).sort((a, b) => a.localeCompare(b)),
    [wards.data],
  );
  const form = useForm<AddManualForm>({
    resolver: zodResolver(addManualSchema),
    defaultValues: { member_email: '', member_name: '', scope: 'stake', reason: '' },
  });
  const { register, handleSubmit, reset, formState } = form;

  // Reset whenever the dialog opens so a previous draft doesn't carry.
  useEffect(() => {
    if (open) reset({ member_email: '', member_name: '', scope: 'stake', reason: '' });
  }, [open, reset]);

  async function onSubmit(input: AddManualForm) {
    try {
      await mutation.mutateAsync(input);
      toast('Manual access added.', 'success');
      onClose();
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title="Add Manual Access"
    >
      <form
        className="kd-wizard-form"
        onSubmit={handleSubmit(onSubmit)}
        data-testid="add-manual-form"
      >
        <label>
          Email
          <Input type="email" {...register('member_email')} placeholder="member@example.com" />
        </label>
        {formState.errors.member_email ? (
          <p role="alert" className="kd-form-error">
            {formState.errors.member_email.message}
          </p>
        ) : null}
        <label>
          Name
          <Input {...register('member_name')} />
        </label>
        {formState.errors.member_name ? (
          <p role="alert" className="kd-form-error">
            {formState.errors.member_name.message}
          </p>
        ) : null}
        <label>
          Scope
          <Select {...register('scope')} disabled={wardsLoading} data-testid="add-manual-scope">
            <option value="stake">Stake</option>
            {wardOptions.map((code) => (
              <option key={code} value={code}>
                {code}
              </option>
            ))}
          </Select>
        </label>
        {wardsLoading ? (
          <p className="kd-form-hint">Loading wards…</p>
        ) : wardOptions.length === 0 ? (
          <p className="kd-form-hint" data-testid="add-manual-no-wards">
            No wards configured. Add wards via Configuration to grant ward-scope access.
          </p>
        ) : null}
        <label>
          Reason
          <Input {...register('reason')} placeholder="Covering bishop" />
        </label>
        {formState.errors.reason ? (
          <p role="alert" className="kd-form-error">
            {formState.errors.reason.message}
          </p>
        ) : null}
        <Dialog.Footer>
          <Dialog.CancelButton>Cancel</Dialog.CancelButton>
          <Button
            type="submit"
            disabled={mutation.isPending || wardsLoading}
            data-testid="access-add-manual-submit"
          >
            {mutation.isPending ? 'Creating…' : 'Create Access'}
          </Button>
        </Dialog.Footer>
      </form>
    </Dialog>
  );
}
