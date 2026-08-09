// Manager Configuration page — multi-tab CRUD over every editable
// table.
//
// Tabs (left → right): Config, Managers, Kindoo Config, Buildings, Wards,
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
// opens the modal pre-populated. Wards: `ward_code` is never shown — it's
// a slug derived from `ward_name` at create and pinned as the doc id.
// Buildings: `building_id` is never shown (it's a slug derived from
// `building_name` server-side). Kindoo Site id is similarly slugged from
// `display_name` at create time and pinned for the doc's life.
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
import { resolveWardBuilding, unitType } from '@kindoo/shared';
import type { Building, KindooSite, Organization, Ward } from '@kindoo/shared';
import {
  buildingSchema,
  configSchema,
  homeKindooSiteSchema,
  kindooSiteFormSchema,
  makeIgnoredWardSchema,
  managerSchema,
  organizationFormSchema,
  wardSchema,
  type BuildingForm,
  type ConfigForm,
  type HomeKindooSiteForm,
  type IgnoredWardForm,
  type KindooSiteForm,
  type ManagerForm,
  type OrganizationForm,
  type WardForm,
} from './schemas';
import {
  useBackfillEqPresidentAccessMutation,
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
  useUpdateHomeKindooSiteMutation,
  useUpdateIgnoredWardsMutation,
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
import { usePrincipal } from '../../../lib/principal';
import { useActiveStake } from '../../../lib/useActiveStake';
import { toast } from '../../../lib/store/toast';
import { WARD_NAME_BRANCH_WARNING, WARD_NAME_HINT, WARD_NAME_LABEL } from '../../../lib/wardCopy';

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
  // Key stays `kindoo-sites` while the label reads "Kindoo Config" —
  // it is in the URL (`?tab=…`), so renaming it would break every
  // existing deep link and bookmark for no user-visible gain.
  { key: 'kindoo-sites', label: 'Kindoo Config' },
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
        Edit Buildings, Wards, Managers, Kindoo Config, Organizations, and stake-level config.
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
    // Sort by the display name — the code is hidden, and legacy uppercase
    // codes would otherwise sort before slug-derived lowercase ones,
    // making the visible order look arbitrary.
    () => [...(wards.data ?? [])].sort((a, b) => a.ward_name.localeCompare(b.ward_name)),
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
          // derives the code from the name. The live wards snapshot drives
          // the unique-display-name guard.
          await upsert.mutateAsync({
            ...(existingWardCode !== undefined ? { ward_code: existingWardCode } : {}),
            ward_name: input.ward_name,
            building_id: input.building_id,
            building_name: selected.building_name,
            seat_cap: input.seat_cap,
            existingWards: wards.data ?? [],
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
  const { register, handleSubmit, reset, formState, watch } = form;

  // Advisory, not validation — see WARD_NAME_BRANCH_WARNING.
  const showsBranchWarning = unitType(watch('ward_name') ?? '') === 'branch';

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
          {WARD_NAME_LABEL}
          <Input {...register('ward_name')} placeholder="Maple Ward" />
        </label>
        <p className="kd-form-hint">{WARD_NAME_HINT}</p>
        {showsBranchWarning ? (
          <p role="status" className="kd-form-error" data-testid="config-ward-branch-warning">
            {WARD_NAME_BRANCH_WARNING}
          </p>
        ) : null}
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
      <HomeKindooSiteSection />

      <SectionHeader
        title="Foreign Kindoo Sites"
        addLabel="Add Foreign Kindoo Site"
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

      <IgnoredWardsSection />
    </div>
  );
}

// ---- Home Kindoo Site -----------------------------------------------
//
// The stake's OWN Kindoo environment — the one the foreign sites below
// are foreign to. It has no `kindooSites` doc; it lives on the parent
// stake doc, and the extension's configure wizard normally writes it
// from the live Kindoo session.
//
// Read-only for managers, editable by platform superadmins. A wrong EID
// silently points every Kindoo operation at another environment, and
// the value is discoverable automatically in the ordinary case — so
// hand-editing is the escape hatch, not the workflow.
//
// Site name shows `kindoo_expected_site_name`, falling back to the
// stake name — the same fallback the description parser and the
// wizard's home-by-name resolution apply, so the row shows what those
// actually compare against rather than an empty field.

function HomeKindooSiteSection() {
  const principal = usePrincipal();
  const stake = useStakeDoc();
  const activeStakeId = useActiveStake();
  const update = useUpdateHomeKindooSiteMutation();
  const [editing, setEditing] = useState(false);

  // Superadmin, with or without a role on this stake. The rule now
  // admits them (T-91) with `setup_complete` and `bootstrap_admin_email`
  // pinned, so the grant stays a config edit rather than a route to a
  // manager claim — the manager half of this gate is no longer what the
  // write requires.
  //
  // Still gated on the stake snapshot arriving. `useForm` captures
  // `defaultValues` once at mount, so opening the editor before
  // `stake.data` lands prefills '' / 0 — and saving then writes the empty
  // form over a real `kindoo_expected_site_name`. Same clobber class the
  // mutation guards for `kindoo_config.site_name`; the tab already gates
  // two other controls on snapshots this way.
  const canEdit =
    principal.isPlatformSuperadmin && activeStakeId !== null && stake.data !== undefined;
  const siteName = stake.data?.kindoo_expected_site_name?.trim() || (stake.data?.stake_name ?? '');
  const isDefaultedName = !stake.data?.kindoo_expected_site_name?.trim();
  const eid = stake.data?.kindoo_config?.site_id ?? null;

  return (
    <div className="kd-config-subsection-lead" data-testid="config-home-kindoo-site">
      <h2>Home Kindoo Site</h2>
      <p className="kd-form-hint">
        This stake’s own Kindoo environment — the one the sites below are foreign to. The
        extension’s configure wizard records it from your live Kindoo session the first time you use
        it.
      </p>

      {editing ? (
        <HomeKindooSiteForm
          eidLocked={eid !== null}
          defaults={{ site_name: siteName, eid: eid ?? 0 }}
          isPending={update.isPending}
          onCancel={() => setEditing(false)}
          onSubmit={async (input) => {
            await update.mutateAsync({ siteName: input.site_name, eid: input.eid });
            setEditing(false);
            toast('Home Kindoo site saved.', 'success');
          }}
        />
      ) : (
        <>
          <ul className="kd-config-rows" data-testid="config-home-kindoo-site-rows">
            <li>
              <span>
                Site name: <strong data-testid="config-home-site-name">{siteName || '—'}</strong>
                {isDefaultedName ? (
                  <em className="kd-form-hint"> (defaults to the stake name)</em>
                ) : null}
              </span>
            </li>
            <li>
              <span>
                Kindoo EID:{' '}
                {eid === null ? (
                  <em data-testid="config-home-site-eid">Not set</em>
                ) : (
                  <code data-testid="config-home-site-eid">{eid}</code>
                )}
              </span>
            </li>
          </ul>
          {canEdit ? (
            <Button
              variant="secondary"
              onClick={() => setEditing(true)}
              data-testid="config-home-kindoo-site-edit"
            >
              Edit
            </Button>
          ) : null}
        </>
      )}
    </div>
  );
}

interface HomeKindooSiteFormProps {
  /** True once `kindoo_config.site_id` exists — the EID is write-once. */
  eidLocked: boolean;
  defaults: HomeKindooSiteForm;
  isPending: boolean;
  onSubmit: (input: HomeKindooSiteForm) => Promise<void>;
  onCancel: () => void;
}

function HomeKindooSiteForm({
  eidLocked,
  defaults,
  isPending,
  onSubmit,
  onCancel,
}: HomeKindooSiteFormProps) {
  const form = useForm<HomeKindooSiteForm>({
    resolver: zodResolver(homeKindooSiteSchema),
    defaultValues: defaults,
  });

  return (
    <form
      className="kd-config-inline-form"
      onSubmit={form.handleSubmit(async (values) => {
        try {
          await onSubmit(values);
        } catch (err) {
          toast(errorMessage(err), 'error');
        }
      })}
      data-testid="config-home-kindoo-site-form"
    >
      <label>
        Kindoo site name
        <Input {...form.register('site_name')} data-testid="config-home-site-name-input" />
      </label>
      {form.formState.errors.site_name ? (
        <p className="kd-form-error">{form.formState.errors.site_name.message}</p>
      ) : null}
      <label>
        Kindoo EID
        {/* No `min` attribute: native constraint validation suppresses the
            submit event entirely, so the zod message below would never
            render. Zod owns the bound.

            `readOnly` rather than `disabled` once locked — a disabled
            input submits nothing, and the mutation needs the unchanged
            value to compare against. The write-once rule is enforced
            there too; this only keeps the operator from meeting it as an
            error. */}
        <Input
          type="number"
          readOnly={eidLocked}
          aria-readonly={eidLocked || undefined}
          {...form.register('eid', { valueAsNumber: true })}
          data-testid="config-home-site-eid-input"
        />
      </label>
      {eidLocked ? (
        <p className="kd-form-hint" data-testid="config-home-site-eid-locked">
          Set once and not editable here. Re-pointing this stake at a different Kindoo environment
          means re-running the extension’s Configure Kindoo wizard, which moves the EID and every
          building’s access-rule mapping together.
        </p>
      ) : null}
      {form.formState.errors.eid ? (
        <p className="kd-form-error">{form.formState.errors.eid.message}</p>
      ) : null}
      <div className="kd-config-row-actions">
        <Button type="submit" disabled={isPending} data-testid="config-home-kindoo-site-save">
          {isPending ? 'Saving…' : 'Save'}
        </Button>
        <Button
          type="button"
          variant="secondary"
          onClick={onCancel}
          data-testid="config-home-kindoo-site-cancel"
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}

// ---- Wards to Ignore in Kindoo --------------------------------------
//
// The mirror image of the Kindoo Sites list above. That list is for
// wards of OURS that live in someone else's Kindoo site; this one is for
// wards of THEIRS that live in one of ours. Both arise from the same
// building-sharing arrangement, which is why they sit on one tab.
//
// Entry is a bare text input rather than a dialog — one free-text field
// with no second field to pair it with. Adds and deletes write the whole
// array straight through; there is no draft state to save.

function IgnoredWardsSection() {
  const stake = useStakeDoc();
  const wards = useWards();
  const update = useUpdateIgnoredWardsMutation();
  const [open, setOpen] = useState(false);

  const ignored = useMemo(() => stake.data?.kindoo_ignored_wards ?? [], [stake.data]);
  const wardNames = useMemo(() => (wards.data ?? []).map((w) => w.ward_name), [wards.data]);

  // Gate Add on the wards snapshot arriving: the dialog's own-ward guard
  // runs against it, and an empty array would wave through an entry that
  // silently does nothing.
  const ready = stake.data !== undefined && wards.data !== undefined;

  const remove = (name: string) => {
    update
      .mutateAsync(ignored.filter((w) => w !== name))
      .then(() => toast('Ward removed from the ignore list.', 'success'))
      .catch((err) => toast(errorMessage(err), 'error'));
  };

  return (
    <div className="kd-config-subsection" data-testid="config-ignored-wards">
      <SectionHeader
        title="Wards to Ignore in Kindoo"
        addLabel="Add Ward to Ignore"
        onAdd={() => setOpen(true)}
        testid="config-ignored-wards"
        addDisabled={!ready}
        addDisabledHint="Loading…"
      />
      <p className="kd-form-hint">
        Wards that appear in one of your Kindoo sites but are managed by a different stake in Stake
        Building Access — typically a neighbouring stake whose wards meet in one of your buildings
        and whose managers provision their own members. Sync skips them, so they aren’t reported as
        members missing a seat. Enter the ward exactly as it appears in Kindoo descriptions, without
        the calling — e.g. <code>Maple Ward</code> to skip <code>Maple Ward (Bishop)</code>, or{' '}
        <code>Peterson Branch</code> to skip <code>Peterson Branch (Branch President)</code>.
      </p>

      <IgnoredWardDialog
        open={open}
        existing={ignored}
        ownWardNames={wardNames}
        isPending={update.isPending}
        onClose={() => setOpen(false)}
        onSubmit={async (ward) => {
          await update.mutateAsync([...ignored, ward]);
          toast('Ward added to the ignore list.', 'success');
        }}
      />

      {ignored.length === 0 ? (
        <p className="kd-empty-state" data-testid="config-ignored-wards-empty">
          No wards ignored. Every Kindoo user is compared against this stake’s seats.
        </p>
      ) : (
        <ul className="kd-config-rows" data-testid="config-ignored-wards-list">
          {ignored.map((name) => (
            <li key={name} data-testid={`config-ignored-ward-row-${name}`}>
              <span>
                <strong>{name}</strong>
              </span>
              <span className="kd-config-row-actions">
                <Button
                  variant="danger"
                  disabled={update.isPending}
                  onClick={() => remove(name)}
                  data-testid={`config-ignored-ward-delete-${name}`}
                >
                  Remove
                </Button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

interface IgnoredWardDialogProps {
  open: boolean;
  /** Live ignore list — feeds the duplicate rule. */
  existing: readonly string[];
  /** Live ward names — feed the own-ward rule. */
  ownWardNames: readonly string[];
  isPending: boolean;
  onSubmit: (ward: string) => Promise<void>;
  onClose: () => void;
}

function IgnoredWardDialog({
  open,
  existing,
  ownWardNames,
  isPending,
  onSubmit,
  onClose,
}: IgnoredWardDialogProps) {
  // Two of the three rules close over live catalogues, so the schema is
  // rebuilt when either changes rather than being a module constant.
  const schema = useMemo(
    () => makeIgnoredWardSchema(existing, ownWardNames),
    [existing, ownWardNames],
  );
  const form = useForm<IgnoredWardForm>({
    resolver: zodResolver(schema),
    defaultValues: { ward: '' },
    // Validate as the operator types: all three rules are about the
    // entry being inert, and finding that out on submit is later than
    // it needs to be.
    mode: 'onChange',
  });
  const { register, handleSubmit, reset, formState } = form;

  useEffect(() => {
    if (open) reset({ ward: '' });
  }, [open, reset]);

  const submit = handleSubmit(async ({ ward }) => {
    try {
      await onSubmit(ward.trim());
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
      title="Add ward to ignore"
    >
      <form onSubmit={submit} className="kd-wizard-form" data-testid="config-ignored-ward-form">
        <label>
          {WARD_NAME_LABEL}
          <Input
            {...register('ward')}
            placeholder="Ward name as Kindoo shows it"
            data-testid="config-ignored-ward-input"
          />
        </label>
        {formState.errors.ward ? (
          <p role="alert" className="kd-form-error" data-testid="config-ignored-ward-error">
            {formState.errors.ward.message}
          </p>
        ) : null}
        <Dialog.Footer>
          <Dialog.CancelButton>Cancel</Dialog.CancelButton>
          <Button type="submit" disabled={isPending} data-testid="config-ignored-ward-submit">
            {isPending ? 'Adding…' : 'Add'}
          </Button>
        </Dialog.Footer>
      </form>
    </Dialog>
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
  const backfill = useBackfillEqPresidentAccessMutation();
  // Non-null while the post-save backfill offer is on screen; the value
  // is the direction the flag just moved.
  const [backfillPrompt, setBackfillPrompt] = useState<'grant' | 'revoke' | null>(null);

  const defaults = useMemo<ConfigForm>(() => {
    const s = stake.data;
    return {
      stake_name: s?.stake_name ?? '',
      stake_seat_cap: s?.stake_seat_cap ?? 0,
      timezone: s?.timezone ?? 'America/Denver',
      notifications_enabled: s?.notifications_enabled ?? true,
      // Opt-in, so absent means off. Deliberately NOT `?? true` like
      // `notifications_enabled` above.
      eq_president_app_access: s?.eq_president_app_access === true,
    };
  }, [stake.data]);

  const form = useForm<ConfigForm>({
    resolver: zodResolver(configSchema),
    values: defaults,
  });
  const { control, register, handleSubmit, formState } = form;

  async function onSubmit(input: ConfigForm) {
    // Read the persisted value before the write lands — the live stake
    // snapshot updates underneath us once the mutation resolves.
    const prev = stake.data?.eq_president_app_access === true;
    try {
      await update.mutateAsync(input);
      toast('Config saved.', 'success');
      // Offer the reconcile pass only on a real flip. The `setup_complete`
      // guard is defensive — routing keeps everyone on the bootstrap
      // wizard until setup completes — but it pins the requirement that
      // initial setup never raises a backfill dialog.
      if (input.eq_president_app_access !== prev && stake.data?.setup_complete === true) {
        setBackfillPrompt(input.eq_president_app_access ? 'grant' : 'revoke');
      }
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  }

  async function onConfirmBackfill() {
    if (!backfillPrompt) return;
    try {
      const res = await backfill.mutateAsync(backfillPrompt);
      toast(
        backfillPrompt === 'grant'
          ? `Granted app access to ${res.docs_written} member(s).`
          : `Revoked app access for ${res.docs_written + res.docs_deleted} member(s).`,
        'success',
      );
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      // Close either way: the config save already landed, and Sync
      // self-heals the access docs on its next run, so a failed backfill
      // is a delay rather than a broken state.
      setBackfillPrompt(null);
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
      <label className="kd-switch-label" htmlFor="config-eq-president-access">
        <Controller
          name="eq_president_app_access"
          control={control}
          render={({ field }) => (
            <Switch
              id="config-eq-president-access"
              checked={field.value === true}
              onCheckedChange={field.onChange}
              data-testid="config-eq-president-access"
            />
          )}
        />
        <span>Elders Quorum Presidents Get App Access</span>
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
      <Dialog
        open={backfillPrompt !== null}
        onOpenChange={(next) => {
          if (!next) setBackfillPrompt(null);
        }}
        dismissable={!backfill.isPending}
        title={
          backfillPrompt === 'revoke'
            ? 'Revoke access from Elders Quorum Presidents?'
            : 'Grant access to current Elders Quorum Presidents?'
        }
        description={
          backfillPrompt === 'revoke'
            ? 'The setting is saved — Sync will no longer grant app access for the Elders Quorum President calling. Do you also want to revoke the access existing Elders Quorum Presidents were already granted? If you skip this, they keep access until their callings next change via Sync.'
            : 'The setting is saved — new Elders Quorum Presidents will get app access as Sync picks up their callings. Do you also want to grant access now to members who currently hold the Elders Quorum President calling?'
        }
      >
        <Dialog.Footer>
          <Dialog.CancelButton data-testid="config-eq-backfill-cancel">
            {backfillPrompt === 'revoke' ? 'Leave access in place' : 'Not now'}
          </Dialog.CancelButton>
          <Dialog.ConfirmButton
            onClick={() => {
              void onConfirmBackfill();
            }}
            disabled={backfill.isPending}
            data-testid="config-eq-backfill-confirm"
          >
            {backfillPrompt === 'revoke' ? 'Revoke access now' : 'Grant access now'}
          </Dialog.ConfirmButton>
        </Dialog.Footer>
      </Dialog>
    </form>
  );
}
