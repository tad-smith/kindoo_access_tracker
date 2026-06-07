// Manager Configuration page — multi-tab CRUD over every editable
// table.
//
// Tabs (left → right): Config, Managers, Kindoo Sites, Buildings, Wards,
// Organizations. Buildings precede Wards because a ward must reference an
// existing building. Organizations sit last — a free-standing seat pool
// with no dependency on the other tables.
//
// Sub-tabs are selected via a query param `?tab=<key>` so the URL
// remains deep-linkable. The TanStack Router file-route validates the
// param.
//
// Every list-bearing tab follows the same pattern: a top-right "Add X"
// button opens a modal with the same react-hook-form + zod form used
// for create. Wards / Buildings rows expose a per-row Edit button that
// opens the modal pre-populated. Wards: `ward_code` is read-only when
// editing (it's the doc id). Buildings: `building_id` is never shown
// (it's a slug derived from `building_name` server-side). Kindoo Site
// id is similarly slugged from `display_name` at create time and pinned
// for the doc's life.
//
// Buildings carry a Kindoo Site selector in their Edit dialog; a ward's
// site is derived from its assigned building, so wards have no site
// field.
//
// The Config tab is single-document; it keeps its inline form, no
// modal.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { resolveWardBuilding } from '@kindoo/shared';
import type { Building, KindooSite, Organization, Ward } from '@kindoo/shared';
import {
  buildingSchema,
  configSchema,
  kindooSiteFormSchema,
  managerSchema,
  organizationFormSchema,
  wardSchema,
  type BuildingForm,
  type ConfigForm,
  type KindooSiteForm,
  type ManagerForm,
  type OrganizationForm,
  type WardForm,
} from './schemas';
import {
  useBuildings,
  useDeleteBuildingMutation,
  useDeleteKindooSiteMutation,
  useDeleteManagerMutation,
  useDeleteOrganizationMutation,
  useDeleteWardMutation,
  useKindooSites,
  useManagers,
  useRequests,
  useSeats,
  useStakeDoc,
  useUpdateStakeConfigMutation,
  useUpsertBuildingMutation,
  useUpsertKindooSiteMutation,
  useUpsertManagerMutation,
  useUpsertOrganizationMutation,
  useUpsertWardMutation,
  useWards,
} from './hooks';
import { useOrganizations, sortOrganizations } from '../../organizations/hooks';
import { TimezoneCombobox } from '../../../components/TimezoneCombobox';
import { Button } from '../../../components/ui/Button';
import { Dialog } from '../../../components/ui/Dialog';
import { Input } from '../../../components/ui/Input';
import { Select } from '../../../components/ui/Select';
import { Switch } from '../../../components/ui/Switch';
import { LoadingSpinner } from '../../../lib/render/LoadingSpinner';
import { toast } from '../../../lib/store/toast';

export type ConfigTabKey =
  | 'config'
  | 'managers'
  | 'wards'
  | 'buildings'
  | 'kindoo-sites'
  | 'organizations';

const TABS: Array<{ key: ConfigTabKey; label: string }> = [
  { key: 'config', label: 'Config' },
  { key: 'managers', label: 'Managers' },
  { key: 'kindoo-sites', label: 'Kindoo Sites' },
  { key: 'buildings', label: 'Buildings' },
  { key: 'wards', label: 'Wards' },
  { key: 'organizations', label: 'Organizations' },
];

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface ConfigurationPageProps {
  initialTab?: ConfigTabKey;
}

export function ConfigurationPage({ initialTab }: ConfigurationPageProps) {
  const tab = initialTab ?? 'config';
  const navigate = useNavigate();

  const switchTab = (next: ConfigTabKey) => {
    navigate({ to: '/manager/configuration', search: { tab: next }, replace: true }).catch(
      () => {},
    );
  };

  return (
    <section className="kd-page-wide">
      <h1>Configuration</h1>
      <p className="kd-page-subtitle">
        Edit Buildings, Wards, Managers, Kindoo Sites, Organizations, and stake-level config.
      </p>

      <nav className="kd-config-tabs" aria-label="Configuration sections">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            className={`kd-config-tab${tab === t.key ? ' active' : ''}`}
            onClick={() => switchTab(t.key)}
            data-testid={`config-tab-${t.key}`}
            aria-current={tab === t.key ? 'page' : undefined}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <div className="kd-config-panel">
        {tab === 'config' ? <ConfigKeysTab /> : null}
        {tab === 'managers' ? <ManagersTab /> : null}
        {tab === 'wards' ? <WardsTab /> : null}
        {tab === 'buildings' ? <BuildingsTab /> : null}
        {tab === 'kindoo-sites' ? <KindooSitesTab /> : null}
        {tab === 'organizations' ? <OrganizationsTab /> : null}
      </div>
    </section>
  );
}

// ---- Section header (title + Add button) ----------------------------

interface SectionHeaderProps {
  title: string;
  addLabel: string;
  onAdd: () => void;
  testid: string;
  addDisabled?: boolean;
  addDisabledHint?: string;
}

function SectionHeader({
  title,
  addLabel,
  onAdd,
  testid,
  addDisabled,
  addDisabledHint,
}: SectionHeaderProps) {
  return (
    <div className="kd-config-section-header">
      <h2>{title}</h2>
      <Button
        onClick={onAdd}
        disabled={addDisabled}
        title={addDisabled ? addDisabledHint : undefined}
        data-testid={`${testid}-add-button`}
      >
        {addLabel}
      </Button>
    </div>
  );
}

// ---- Wards tab ------------------------------------------------------

function WardsTab() {
  const wards = useWards();
  const buildings = useBuildings();
  const upsert = useUpsertWardMutation();
  const del = useDeleteWardMutation();

  const [openMode, setOpenMode] = useState<'closed' | 'add' | { kind: 'edit'; ward: Ward }>(
    'closed',
  );

  const sorted = useMemo(
    () => [...(wards.data ?? [])].sort((a, b) => a.ward_code.localeCompare(b.ward_code)),
    [wards.data],
  );

  // A ward must reference an existing building. Gate Add on the
  // buildings snapshot having arrived (mirrors `deleteReady`
  // elsewhere): while `buildings.data` is undefined (loading) we must
  // NOT flash the "Add a building first" hint — deep-linking ?tab=wards
  // would otherwise show it on stakes that DO have buildings — but we
  // also must not open the dialog against an unhydrated catalogue (the
  // <Select> would be empty and the submit resolver couldn't map the
  // chosen `building_id` to its current display name). So Add stays
  // disabled until the snapshot lands; once it does, the known-empty
  // case shows the hint and the populated case enables Add.
  const buildingsReady = buildings.data !== undefined;
  const noBuildings = buildingsReady && buildings.data!.length === 0;

  return (
    <div className="kd-config-section">
      <SectionHeader
        title="Wards"
        addLabel="Add Ward"
        onAdd={() => {
          if (!buildingsReady || noBuildings) return;
          setOpenMode('add');
        }}
        testid="config-wards"
        addDisabled={!buildingsReady || noBuildings}
        addDisabledHint={noBuildings ? 'Add a building first.' : 'Loading…'}
      />
      {noBuildings ? (
        <p className="kd-form-hint" data-testid="config-wards-no-buildings-hint">
          Add a building first.
        </p>
      ) : null}
      <ul className="kd-config-rows" data-testid="config-wards-list">
        {sorted.map((w) => (
          <li key={w.ward_code}>
            <span>
              <strong>{w.ward_name}</strong> — building: {w.building_name} · cap {w.seat_cap}
            </span>
            <span className="kd-config-row-actions">
              <Button
                variant="secondary"
                onClick={() => setOpenMode({ kind: 'edit', ward: w })}
                data-testid={`config-ward-edit-${w.ward_code}`}
              >
                Edit
              </Button>
              <Button
                variant="danger"
                onClick={() =>
                  del
                    .mutateAsync(w.ward_code)
                    .then(() => toast('Ward deleted.', 'success'))
                    .catch((err) => toast(errorMessage(err), 'error'))
                }
                data-testid={`config-ward-delete-${w.ward_code}`}
              >
                Delete
              </Button>
            </span>
          </li>
        ))}
      </ul>

      <WardFormDialog
        mode={openMode}
        buildingOptions={buildings.data ?? []}
        isPending={upsert.isPending}
        onSubmit={async (input, existingWardCode) => {
          // The form carries the immutable `building_id`; resolve the
          // selected building's current display name and write both
          // (id-first FK + legacy name snapshot for stale bundles).
          const selected = (buildings.data ?? []).find((b) => b.building_id === input.building_id);
          if (!selected) throw new Error('Selected building no longer exists.');
          // On EDIT pass the existing doc id through so the mutation
          // targets the same ward; on CREATE omit it so the mutation
          // derives the code from the name.
          await upsert.mutateAsync({
            ...(existingWardCode !== undefined ? { ward_code: existingWardCode } : {}),
            ward_name: input.ward_name,
            building_id: input.building_id,
            building_name: selected.building_name,
            seat_cap: input.seat_cap,
          });
          toast('Ward saved.', 'success');
        }}
        onClose={() => setOpenMode('closed')}
      />
    </div>
  );
}

// Kindoo Site form field rendered inside the Building dialog. "Home"
// (form value = `null`) is the default option; foreign sites follow.
// The dialog form persists `kindoo_site_id` alongside the rest of the
// building's fields via the existing upsert mutation — no inline
// auto-save on the list rows.
//
// Wrapped over the `<select>` so the form-control hidden-value carries
// `string | null` straight into the RHF state (the sentinel
// `__home__` only exists as a DOM value).
interface KindooSiteFormFieldProps {
  value: string | null;
  sites: ReadonlyArray<KindooSite>;
  onChange: (next: string | null) => void;
  testid: string;
}

function KindooSiteFormField({ value, sites, onChange, testid }: KindooSiteFormFieldProps) {
  const sortedSites = useMemo(
    () => [...sites].sort((a, b) => a.display_name.localeCompare(b.display_name)),
    [sites],
  );
  return (
    <Select
      value={value ?? '__home__'}
      onChange={(e) => {
        const next = e.target.value;
        onChange(next === '__home__' ? null : next);
      }}
      data-testid={testid}
    >
      <option value="__home__">Home</option>
      {sortedSites.map((s) => (
        <option key={s.id} value={s.id}>
          {s.display_name}
        </option>
      ))}
    </Select>
  );
}

interface WardFormDialogProps {
  mode: 'closed' | 'add' | { kind: 'edit'; ward: Ward };
  buildingOptions: readonly Building[];
  isPending: boolean;
  /**
   * `existingWardCode` is the edited ward's immutable doc id on the edit
   * path, `undefined` on create (the mutation derives the code from the
   * name).
   */
  onSubmit: (input: WardForm, existingWardCode: string | undefined) => Promise<void>;
  onClose: () => void;
}

function wardFormDefaults(editingWard: Ward | null, buildings: readonly Building[]): WardForm {
  if (!editingWard) {
    return {
      ward_name: '',
      building_id: '',
      seat_cap: 20,
    };
  }
  // Preselect by `building_id`; on a legacy ward (id absent) resolve it
  // from the building catalogue by `building_name` so the dropdown lands
  // on the right option.
  const resolved = resolveWardBuilding(editingWard, buildings);
  return {
    ward_name: editingWard.ward_name,
    building_id: editingWard.building_id ?? resolved?.building_id ?? '',
    seat_cap: editingWard.seat_cap,
  };
}

function WardFormDialog({
  mode,
  buildingOptions,
  isPending,
  onSubmit,
  onClose,
}: WardFormDialogProps) {
  const isEdit = typeof mode === 'object' && mode.kind === 'edit';
  const editingWard = isEdit ? mode.ward : null;
  const open = mode !== 'closed';

  const form = useForm<WardForm>({
    resolver: zodResolver(wardSchema),
    defaultValues: wardFormDefaults(editingWard, buildingOptions),
  });
  const { register, handleSubmit, reset, formState } = form;

  // Keep the latest buildings snapshot in a ref so the reset effect can
  // read it at open-time WITHOUT depending on its identity. The
  // catalogue is only needed to resolve a legacy ward's `building_id`
  // from its `building_name` once, when the dialog opens — listing
  // `buildingOptions` in the effect deps would re-fire reset() on every
  // buildings-collection snapshot (an unrelated building add/edit in
  // another tab, or the next hydration snapshot) and clobber a
  // manager's in-progress edit. The <Select> options below stay live
  // off `buildingOptions` directly; only the reset is decoupled.
  const buildingOptionsRef = useRef(buildingOptions);
  buildingOptionsRef.current = buildingOptions;

  // Reset only when the dialog flips open or the editing target changes
  // — RHF drives the form after the first reset; later buildings
  // snapshots must not stomp on user edits.
  useEffect(() => {
    if (!open) return;
    reset(wardFormDefaults(editingWard, buildingOptionsRef.current));
  }, [open, editingWard, reset]);

  const submit = handleSubmit(async (input) => {
    try {
      await onSubmit(input, editingWard?.ward_code);
      onClose();
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={isEdit ? 'Edit ward' : 'Add ward'}
    >
      <form onSubmit={submit} className="kd-wizard-form" data-testid="config-ward-form">
        <label>
          Ward name
          <Input {...register('ward_name')} placeholder="Maple Ward" />
        </label>
        {formState.errors.ward_name ? (
          <p role="alert" className="kd-form-error">
            {formState.errors.ward_name.message}
          </p>
        ) : null}
        <label>
          Building
          <Select {...register('building_id')}>
            <option value="">— Select —</option>
            {buildingOptions.map((b) => (
              <option key={b.building_id} value={b.building_id}>
                {b.building_name}
              </option>
            ))}
          </Select>
        </label>
        {formState.errors.building_id ? (
          <p role="alert" className="kd-form-error">
            {formState.errors.building_id.message}
          </p>
        ) : null}
        <label>
          Seat cap
          <Input type="number" min={0} {...register('seat_cap', { valueAsNumber: true })} />
        </label>
        {formState.errors.seat_cap ? (
          <p role="alert" className="kd-form-error">
            {formState.errors.seat_cap.message}
          </p>
        ) : null}
        <Dialog.Footer>
          <Dialog.CancelButton>Cancel</Dialog.CancelButton>
          <Button type="submit" disabled={isPending} data-testid="config-ward-submit">
            {isPending ? 'Saving…' : isEdit ? 'Save changes' : 'Create ward'}
          </Button>
        </Dialog.Footer>
      </form>
    </Dialog>
  );
}

// ---- Buildings tab --------------------------------------------------

function BuildingsTab() {
  const buildings = useBuildings();
  // Subscribe to wards so the building delete ref-guard can block when
  // any ward references this building (wards FK on building_name).
  const wards = useWards();
  // Subscribe to seats + requests so the rename ref-guard can block an
  // in-place rename while any active seat / pending request snapshots
  // the building's current display name (display-name arrays — §3.2).
  const seats = useSeats();
  const requests = useRequests();
  const kindooSites = useKindooSites();
  const upsert = useUpsertBuildingMutation();
  const del = useDeleteBuildingMutation();

  const [openMode, setOpenMode] = useState<'closed' | 'add' | { kind: 'edit'; building: Building }>(
    'closed',
  );

  const sorted = useMemo(
    () =>
      [...(buildings.data ?? [])].sort((a, b) => a.building_name.localeCompare(b.building_name)),
    [buildings.data],
  );

  // Gate Delete on the wards snapshot arriving. Deep-linking into
  // ?tab=buildings can land the Delete button before wards.data is
  // defined; without this gate the FK ref-guard runs against [] and
  // deletes a building that real wards still reference.
  const deleteReady = wards.data !== undefined;

  // Gate Add on the buildings snapshot arriving (mirrors `deleteReady`).
  // Deep-linking ?tab=buildings can land a click before buildings.data
  // hydrates; without this gate the unique-display-name guard runs
  // against [] and a duplicate name slips through on the first click.
  const buildingsReady = buildings.data !== undefined;

  // Gate Edit on the seats + requests snapshots arriving (mirrors
  // `deleteReady`). Deep-linking ?tab=buildings can land an Edit click
  // before those snapshots hydrate; without this gate the rename
  // ref-guard runs against [] and a rename slips through on the first
  // click while active seats / pending requests still snapshot the old
  // name. Add doesn't need this — creates can't rename.
  const renameRefsReady = seats.data !== undefined && requests.data !== undefined;

  return (
    <div className="kd-config-section">
      <SectionHeader
        title="Buildings"
        addLabel="Add Building"
        onAdd={() => {
          if (!buildingsReady) return;
          setOpenMode('add');
        }}
        testid="config-buildings"
        addDisabled={!buildingsReady}
        addDisabledHint="Loading…"
      />
      <ul className="kd-config-rows" data-testid="config-buildings-list">
        {sorted.map((b) => (
          <li key={b.building_id}>
            <span>
              <strong>{b.building_name}</strong>
              {b.address ? <> — {b.address}</> : null}
            </span>
            <span className="kd-config-row-actions">
              <Button
                variant="secondary"
                disabled={!renameRefsReady}
                title={renameRefsReady ? undefined : 'Loading…'}
                onClick={() => {
                  if (!renameRefsReady) return;
                  setOpenMode({ kind: 'edit', building: b });
                }}
                data-testid={`config-building-edit-${b.building_id}`}
              >
                {renameRefsReady ? 'Edit' : 'Loading…'}
              </Button>
              <Button
                variant="danger"
                disabled={!deleteReady}
                title={deleteReady ? undefined : 'Loading…'}
                onClick={() => {
                  if (!deleteReady) return;
                  del
                    .mutateAsync({
                      buildingId: b.building_id,
                      buildingName: b.building_name,
                      wards: wards.data ?? [],
                    })
                    .then(() => toast('Building deleted.', 'success'))
                    .catch((err) => toast(errorMessage(err), 'error'));
                }}
                data-testid={`config-building-delete-${b.building_id}`}
              >
                {deleteReady ? 'Delete' : 'Loading…'}
              </Button>
            </span>
          </li>
        ))}
      </ul>

      <BuildingFormDialog
        mode={openMode}
        kindooSiteOptions={kindooSites.data ?? []}
        isPending={upsert.isPending}
        onSubmit={async (input, editingBuildingId) => {
          // The building's current display name (edit only) so the
          // rename ref-guard can tell whether the name is changing.
          const previousBuildingName = editingBuildingId
            ? (buildings.data ?? []).find((b) => b.building_id === editingBuildingId)?.building_name
            : undefined;
          await upsert.mutateAsync({
            ...input,
            // Carry the original slug through on edit so the write hits
            // the SAME doc and never re-slugs a renamed building.
            ...(editingBuildingId ? { building_id: editingBuildingId } : {}),
            existingBuildings: buildings.data ?? [],
            // Rename ref-guard inputs: the current name + the live
            // seats / pending-requests catalogues the guard checks.
            ...(previousBuildingName !== undefined ? { previousBuildingName } : {}),
            seats: seats.data ?? [],
            pendingRequests: requests.data ?? [],
          });
          toast('Building saved.', 'success');
        }}
        onClose={() => setOpenMode('closed')}
      />
    </div>
  );
}

interface BuildingFormDialogProps {
  mode: 'closed' | 'add' | { kind: 'edit'; building: Building };
  kindooSiteOptions: readonly KindooSite[];
  isPending: boolean;
  /** `editingBuildingId` is the immutable slug on edit, `null` on create. */
  onSubmit: (input: BuildingForm, editingBuildingId: string | null) => Promise<void>;
  onClose: () => void;
}

function buildingFormDefaults(editingBuilding: Building | null): BuildingForm {
  return editingBuilding
    ? {
        building_name: editingBuilding.building_name,
        address: editingBuilding.address ?? '',
        kindoo_site_id: editingBuilding.kindoo_site_id ?? null,
      }
    : { building_name: '', address: '', kindoo_site_id: null };
}

function BuildingFormDialog({
  mode,
  kindooSiteOptions,
  isPending,
  onSubmit,
  onClose,
}: BuildingFormDialogProps) {
  const isEdit = typeof mode === 'object' && mode.kind === 'edit';
  const editingBuilding = isEdit ? mode.building : null;
  const open = mode !== 'closed';

  const form = useForm<BuildingForm>({
    resolver: zodResolver(buildingSchema),
    defaultValues: buildingFormDefaults(editingBuilding),
  });
  const { control, register, handleSubmit, reset, formState } = form;

  useEffect(() => {
    if (!open) return;
    reset(buildingFormDefaults(editingBuilding));
  }, [open, editingBuilding, reset]);

  const submit = handleSubmit(async (input) => {
    try {
      await onSubmit(input, editingBuilding?.building_id ?? null);
      onClose();
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={isEdit ? `Edit building — ${editingBuilding?.building_name ?? ''}` : 'Add building'}
    >
      <form onSubmit={submit} className="kd-wizard-form" data-testid="config-building-form">
        <label>
          Name
          <Input {...register('building_name')} placeholder="Maple Building" />
        </label>
        {formState.errors.building_name ? (
          <p role="alert" className="kd-form-error">
            {formState.errors.building_name.message}
          </p>
        ) : null}
        <label>
          Address
          <Input {...register('address')} placeholder="123 Main St" />
        </label>
        <label>
          Kindoo site
          <Controller
            name="kindoo_site_id"
            control={control}
            render={({ field }) => (
              <KindooSiteFormField
                value={field.value ?? null}
                sites={kindooSiteOptions}
                onChange={field.onChange}
                testid="config-building-kindoo-site"
              />
            )}
          />
        </label>
        <Dialog.Footer>
          <Dialog.CancelButton>Cancel</Dialog.CancelButton>
          <Button type="submit" disabled={isPending} data-testid="config-building-submit">
            {isPending ? 'Saving…' : isEdit ? 'Save changes' : 'Create building'}
          </Button>
        </Dialog.Footer>
      </form>
    </Dialog>
  );
}

// ---- Kindoo Sites tab -----------------------------------------------
//
// Foreign Kindoo environments this stake's managers can write to. Home
// site is implicit (lives on the parent stake doc); the UI only edits
// the foreign-site rows. Buildings carry a `kindoo_site_id` that points
// at a row here (or `null` for home); a ward's site is derived from its
// building.

function KindooSitesTab() {
  const sites = useKindooSites();
  // Subscribe to buildings so the delete ref-guard can block when a
  // building still points at this site (buildings carry the
  // kindoo_site_id FK; rules don't enforce field-level integrity).
  const buildings = useBuildings();
  const upsert = useUpsertKindooSiteMutation();
  const del = useDeleteKindooSiteMutation();

  const [openMode, setOpenMode] = useState<'closed' | 'add' | { kind: 'edit'; site: KindooSite }>(
    'closed',
  );

  const sorted = useMemo(
    () => [...(sites.data ?? [])].sort((a, b) => a.display_name.localeCompare(b.display_name)),
    [sites.data],
  );

  // Gate Delete on the buildings snapshot arriving. Deep-linking into
  // ?tab=kindoo-sites can land the Delete button before buildings.data
  // is defined; without this gate the FK ref-guard runs against [] and
  // deletes a site that real buildings still reference.
  const deleteReady = buildings.data !== undefined;

  return (
    <div className="kd-config-section">
      <SectionHeader
        title="Kindoo Sites"
        addLabel="Add Kindoo Site"
        onAdd={() => setOpenMode('add')}
        testid="config-kindoo-sites"
      />
      <p className="kd-form-hint">
        Additional Kindoo sites your managers operate alongside the home site. Buildings can be
        assigned to a Kindoo site so the extension knows which site to provision against; a ward
        inherits its building's site. The home site is implicit — leave buildings on “Home” unless
        they belong to a different Kindoo environment.
      </p>
      {sorted.length === 0 ? (
        <p className="kd-empty-state" data-testid="config-kindoo-sites-empty">
          No foreign Kindoo sites configured. All buildings default to the home site.
        </p>
      ) : (
        <ul className="kd-config-rows" data-testid="config-kindoo-sites-list">
          {sorted.map((s) => (
            <li key={s.id} data-testid={`config-kindoo-sites-row-${s.id}`}>
              <span>
                <strong>{s.display_name}</strong> — site name:{' '}
                <code>{s.kindoo_expected_site_name}</code>
              </span>
              <span className="kd-config-row-actions">
                <Button
                  variant="secondary"
                  onClick={() => setOpenMode({ kind: 'edit', site: s })}
                  data-testid={`config-kindoo-site-edit-${s.id}`}
                >
                  Edit
                </Button>
                <Button
                  variant="danger"
                  disabled={!deleteReady}
                  title={deleteReady ? undefined : 'Loading…'}
                  onClick={() => {
                    if (!deleteReady) return;
                    del
                      .mutateAsync({
                        kindooSiteId: s.id,
                        buildings: buildings.data ?? [],
                      })
                      .then(() => toast('Kindoo site deleted.', 'success'))
                      .catch((err) => toast(errorMessage(err), 'error'));
                  }}
                  data-testid={`config-kindoo-site-delete-${s.id}`}
                >
                  {deleteReady ? 'Delete' : 'Loading…'}
                </Button>
              </span>
            </li>
          ))}
        </ul>
      )}

      <KindooSiteFormDialog
        mode={openMode}
        isPending={upsert.isPending}
        onSubmit={async (input, existingId) => {
          await upsert.mutateAsync({ ...input, ...(existingId ? { id: existingId } : {}) });
          toast('Kindoo site saved.', 'success');
        }}
        onClose={() => setOpenMode('closed')}
      />
    </div>
  );
}

interface KindooSiteFormDialogProps {
  mode: 'closed' | 'add' | { kind: 'edit'; site: KindooSite };
  isPending: boolean;
  onSubmit: (input: KindooSiteForm, existingId: string | null) => Promise<void>;
  onClose: () => void;
}

function KindooSiteFormDialog({ mode, isPending, onSubmit, onClose }: KindooSiteFormDialogProps) {
  const isEdit = typeof mode === 'object' && mode.kind === 'edit';
  const editingSite = isEdit ? mode.site : null;
  const open = mode !== 'closed';

  const defaults: KindooSiteForm = editingSite
    ? {
        display_name: editingSite.display_name,
        kindoo_expected_site_name: editingSite.kindoo_expected_site_name,
      }
    : { display_name: '', kindoo_expected_site_name: '' };

  const form = useForm<KindooSiteForm>({
    resolver: zodResolver(kindooSiteFormSchema),
    defaultValues: defaults,
  });
  const { register, handleSubmit, reset, formState } = form;

  useEffect(() => {
    if (!open) return;
    reset(defaults);
    // `defaults` is derived from `editingSite`; depending on it
    // directly captures the active edit target without an extra ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editingSite, reset]);

  const submit = handleSubmit(async (input) => {
    try {
      await onSubmit(input, editingSite?.id ?? null);
      onClose();
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={isEdit ? `Edit Kindoo site — ${editingSite?.display_name ?? ''}` : 'Add Kindoo site'}
    >
      <form onSubmit={submit} className="kd-wizard-form" data-testid="config-kindoo-site-form">
        <label>
          Display name
          <Input {...register('display_name')} placeholder="East Stake (Pine Building)" />
        </label>
        {formState.errors.display_name ? (
          <p role="alert" className="kd-form-error">
            {formState.errors.display_name.message}
          </p>
        ) : null}
        <label>
          Kindoo site name
          <Input
            {...register('kindoo_expected_site_name')}
            placeholder="Matches the name Kindoo shows for the site"
          />
        </label>
        {formState.errors.kindoo_expected_site_name ? (
          <p role="alert" className="kd-form-error">
            {formState.errors.kindoo_expected_site_name.message}
          </p>
        ) : null}
        <Dialog.Footer>
          <Dialog.CancelButton>Cancel</Dialog.CancelButton>
          <Button type="submit" disabled={isPending} data-testid="config-kindoo-site-submit">
            {isPending ? 'Saving…' : isEdit ? 'Save changes' : 'Create Kindoo site'}
          </Button>
        </Dialog.Footer>
      </form>
    </Dialog>
  );
}

// ---- Organizations tab ----------------------------------------------
//
// Stake-level seat pools managers track alongside wards / buildings.
// `organization_id` is a slug derived from `name` at create time and
// pinned for the doc's life (renaming does NOT re-slug — seats /
// requests reference the immutable slug via `organization_id`). The
// form edits only `name` + `seat_cap`. Delete is blocked while any seat
// references the org (primary `organization_id` or any
// `duplicate_grants[].organization_id`); the guard runs client-side
// against the live seats snapshot (rules can't iterate siblings).

function OrganizationsTab() {
  const orgs = useOrganizations();
  // Subscribe to seats so the delete ref-guard can block when any seat
  // references this org (primary or duplicate-grant organization_id).
  const seats = useSeats();
  const upsert = useUpsertOrganizationMutation();
  const del = useDeleteOrganizationMutation();

  const [openMode, setOpenMode] = useState<'closed' | 'add' | { kind: 'edit'; org: Organization }>(
    'closed',
  );

  const sorted = useMemo(() => sortOrganizations(orgs.data), [orgs.data]);

  // Gate Add on the organizations snapshot arriving (mirrors the
  // Buildings tab). Deep-linking ?tab=organizations can land a click
  // before orgs.data hydrates; without this gate the unique-name guard
  // runs against [] and a duplicate name slips through on the first
  // click.
  const orgsReady = orgs.data !== undefined;

  // Gate Delete on the seats snapshot arriving. Deep-linking can land
  // the Delete button before seats.data is defined; without this gate
  // the ref-guard runs against [] and deletes an org that real seats
  // still reference.
  const deleteReady = seats.data !== undefined;

  return (
    <div className="kd-config-section">
      <SectionHeader
        title="Organizations"
        addLabel="Add Organization"
        onAdd={() => {
          if (!orgsReady) return;
          setOpenMode('add');
        }}
        testid="config-organizations"
        addDisabled={!orgsReady}
        addDisabledHint="Loading…"
      />
      {sorted.length === 0 ? (
        <p className="kd-empty-state" data-testid="config-organizations-empty">
          No organizations configured. Add one to assign stake-scope seats to it.
        </p>
      ) : (
        <ul className="kd-config-rows" data-testid="config-organizations-list">
          {sorted.map((o) => (
            <li
              key={o.organization_id}
              data-testid={`config-organizations-row-${o.organization_id}`}
            >
              <span>
                <strong>{o.name}</strong> — cap {o.seat_cap}
              </span>
              <span className="kd-config-row-actions">
                <Button
                  variant="secondary"
                  onClick={() => setOpenMode({ kind: 'edit', org: o })}
                  data-testid={`config-organization-edit-${o.organization_id}`}
                >
                  Edit
                </Button>
                <Button
                  variant="danger"
                  disabled={!deleteReady}
                  title={deleteReady ? undefined : 'Loading…'}
                  onClick={() => {
                    if (!deleteReady) return;
                    del
                      .mutateAsync({
                        organizationId: o.organization_id,
                        seats: seats.data ?? [],
                      })
                      .then(() => toast('Organization deleted.', 'success'))
                      .catch((err) => toast(errorMessage(err), 'error'));
                  }}
                  data-testid={`config-organization-delete-${o.organization_id}`}
                >
                  {deleteReady ? 'Delete' : 'Loading…'}
                </Button>
              </span>
            </li>
          ))}
        </ul>
      )}

      <OrganizationFormDialog
        mode={openMode}
        isPending={upsert.isPending}
        onSubmit={async (input, editingOrgId) => {
          await upsert.mutateAsync({
            ...input,
            // Carry the original slug through on edit so the write hits
            // the SAME doc and never re-slugs a renamed organization.
            ...(editingOrgId ? { organization_id: editingOrgId } : {}),
            existingOrganizations: orgs.data ?? [],
          });
          toast('Organization saved.', 'success');
        }}
        onClose={() => setOpenMode('closed')}
      />
    </div>
  );
}

interface OrganizationFormDialogProps {
  mode: 'closed' | 'add' | { kind: 'edit'; org: Organization };
  isPending: boolean;
  /** `editingOrgId` is the immutable slug on edit, `null` on create. */
  onSubmit: (input: OrganizationForm, editingOrgId: string | null) => Promise<void>;
  onClose: () => void;
}

function organizationFormDefaults(editingOrg: Organization | null): OrganizationForm {
  return editingOrg
    ? { name: editingOrg.name, seat_cap: editingOrg.seat_cap }
    : { name: '', seat_cap: 0 };
}

function OrganizationFormDialog({
  mode,
  isPending,
  onSubmit,
  onClose,
}: OrganizationFormDialogProps) {
  const isEdit = typeof mode === 'object' && mode.kind === 'edit';
  const editingOrg = isEdit ? mode.org : null;
  const open = mode !== 'closed';

  const form = useForm<OrganizationForm>({
    resolver: zodResolver(organizationFormSchema),
    defaultValues: organizationFormDefaults(editingOrg),
  });
  const { register, handleSubmit, reset, formState } = form;

  useEffect(() => {
    if (!open) return;
    reset(organizationFormDefaults(editingOrg));
  }, [open, editingOrg, reset]);

  const submit = handleSubmit(async (input) => {
    try {
      await onSubmit(input, editingOrg?.organization_id ?? null);
      onClose();
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={isEdit ? `Edit organization — ${editingOrg?.name ?? ''}` : 'Add organization'}
    >
      <form onSubmit={submit} className="kd-wizard-form" data-testid="config-organization-form">
        <label>
          Name
          <Input {...register('name')} placeholder="Primary Children" />
        </label>
        {formState.errors.name ? (
          <p role="alert" className="kd-form-error">
            {formState.errors.name.message}
          </p>
        ) : null}
        <label>
          Seat cap
          <Input type="number" min={0} {...register('seat_cap', { valueAsNumber: true })} />
        </label>
        {formState.errors.seat_cap ? (
          <p role="alert" className="kd-form-error">
            {formState.errors.seat_cap.message}
          </p>
        ) : null}
        <Dialog.Footer>
          <Dialog.CancelButton>Cancel</Dialog.CancelButton>
          <Button type="submit" disabled={isPending} data-testid="config-organization-submit">
            {isPending ? 'Saving…' : isEdit ? 'Save changes' : 'Create organization'}
          </Button>
        </Dialog.Footer>
      </form>
    </Dialog>
  );
}

// ---- Managers tab ---------------------------------------------------

function ManagersTab() {
  const managers = useManagers();
  const upsert = useUpsertManagerMutation();
  const del = useDeleteManagerMutation();

  const [open, setOpen] = useState(false);

  const sorted = useMemo(
    () =>
      [...(managers.data ?? [])].sort((a, b) =>
        a.member_canonical.localeCompare(b.member_canonical),
      ),
    [managers.data],
  );
  // Last-manager guard. When only one manager remains, that row's
  // Delete button is disabled with a tooltip — preventing the operator
  // from locking themselves out of the app. Reactive to count changes.
  const isLastManager = sorted.length === 1;

  return (
    <div className="kd-config-section">
      <SectionHeader
        title="Kindoo Managers"
        addLabel="Add Manager"
        onAdd={() => setOpen(true)}
        testid="config-managers"
      />
      <ul className="kd-config-rows" data-testid="config-managers-list">
        {sorted.map((m) => (
          <li key={m.member_canonical}>
            <span>
              <strong>{m.name || m.member_email}</strong> <code>{m.member_email}</code>
              {!m.active ? <em> (inactive)</em> : null}
            </span>
            <Button
              variant="danger"
              disabled={isLastManager}
              title={isLastManager ? 'Cannot remove the last Kindoo Manager.' : undefined}
              onClick={() =>
                del
                  .mutateAsync(m.member_canonical)
                  .then(() => toast('Manager deleted.', 'success'))
                  .catch((err) => toast(errorMessage(err), 'error'))
              }
              data-testid={`config-manager-delete-${m.member_canonical}`}
            >
              Delete
            </Button>
          </li>
        ))}
      </ul>

      <ManagerFormDialog
        open={open}
        isPending={upsert.isPending}
        onSubmit={async (input) => {
          await upsert.mutateAsync(input);
          toast('Manager saved.', 'success');
        }}
        onClose={() => setOpen(false)}
      />
    </div>
  );
}

interface ManagerFormDialogProps {
  open: boolean;
  isPending: boolean;
  onSubmit: (input: ManagerForm) => Promise<void>;
  onClose: () => void;
}

function ManagerFormDialog({ open, isPending, onSubmit, onClose }: ManagerFormDialogProps) {
  const form = useForm<ManagerForm>({
    resolver: zodResolver(managerSchema),
    defaultValues: { member_email: '', name: '' },
  });
  const { register, handleSubmit, reset, formState } = form;

  useEffect(() => {
    if (!open) return;
    reset({ member_email: '', name: '' });
  }, [open, reset]);

  const submit = handleSubmit(async (input) => {
    try {
      await onSubmit(input);
      onClose();
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title="Add Kindoo Manager"
    >
      <form onSubmit={submit} className="kd-wizard-form" data-testid="config-manager-form">
        <label>
          Email
          <Input type="email" {...register('member_email')} placeholder="manager@example.com" />
        </label>
        {formState.errors.member_email ? (
          <p role="alert" className="kd-form-error">
            {formState.errors.member_email.message}
          </p>
        ) : null}
        <label>
          Name
          <Input {...register('name')} placeholder="Manager Name" />
        </label>
        {formState.errors.name ? (
          <p role="alert" className="kd-form-error">
            {formState.errors.name.message}
          </p>
        ) : null}
        <Dialog.Footer>
          <Dialog.CancelButton>Cancel</Dialog.CancelButton>
          <Button type="submit" disabled={isPending} data-testid="config-manager-submit">
            {isPending ? 'Saving…' : 'Create manager'}
          </Button>
        </Dialog.Footer>
      </form>
    </Dialog>
  );
}

// ---- Config keys tab ------------------------------------------------

function ConfigKeysTab() {
  const stake = useStakeDoc();
  const update = useUpdateStakeConfigMutation();

  const defaults = useMemo<ConfigForm>(() => {
    const s = stake.data;
    return {
      stake_name: s?.stake_name ?? '',
      stake_seat_cap: s?.stake_seat_cap ?? 0,
      timezone: s?.timezone ?? 'America/Denver',
      notifications_enabled: s?.notifications_enabled ?? true,
    };
  }, [stake.data]);

  const form = useForm<ConfigForm>({
    resolver: zodResolver(configSchema),
    values: defaults,
  });
  const { control, register, handleSubmit, formState } = form;

  async function onSubmit(input: ConfigForm) {
    try {
      await update.mutateAsync(input);
      toast('Config saved.', 'success');
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  }

  if (stake.isLoading || stake.data === undefined) {
    return <LoadingSpinner />;
  }

  return (
    <form className="kd-wizard-form" onSubmit={handleSubmit(onSubmit)}>
      <h2>Stake config</h2>
      <label>
        Stake name
        <Input {...register('stake_name')} />
      </label>
      <label>
        Stake seat cap
        <Input type="number" min={0} {...register('stake_seat_cap', { valueAsNumber: true })} />
      </label>
      <label htmlFor="config-timezone">
        Timezone (IANA, e.g. America/Denver)
        <Controller
          name="timezone"
          control={control}
          render={({ field }) => (
            <TimezoneCombobox
              id="config-timezone"
              value={field.value}
              onChange={field.onChange}
              data-testid="config-timezone"
            />
          )}
        />
      </label>
      <label className="kd-switch-label" htmlFor="config-notifications-enabled">
        <Controller
          name="notifications_enabled"
          control={control}
          render={({ field }) => (
            <Switch
              id="config-notifications-enabled"
              checked={field.value === true}
              onCheckedChange={field.onChange}
              data-testid="config-notifications-enabled"
            />
          )}
        />
        <span>Email Notifications Enabled</span>
      </label>
      {formState.errors.stake_name ? (
        <p role="alert" className="kd-form-error">
          {formState.errors.stake_name.message}
        </p>
      ) : null}
      <div className="form-actions">
        <Button type="submit" disabled={update.isPending}>
          {update.isPending ? 'Saving…' : 'Save config'}
        </Button>
      </div>
    </form>
  );
}
