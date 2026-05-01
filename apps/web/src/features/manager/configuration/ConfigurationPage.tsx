// Manager Configuration page — multi-tab CRUD over every editable
// table. Mirrors `src/ui/manager/Config.html` from the Apps Script app.
//
// Tabs (left → right): Config, Managers, Wards, Buildings,
// Auto Ward Callings, Auto Stake Callings.
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
// (it's a slug derived from `building_name` server-side).
//
// The Config tab is single-document; it keeps its inline form, no
// modal.

import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { Building, Ward, WardCallingTemplate } from '@kindoo/shared';
import {
  buildingSchema,
  callingTemplateSchema,
  configSchema,
  managerSchema,
  wardSchema,
  type BuildingForm,
  type CallingTemplateForm,
  type ConfigForm,
  type ManagerForm,
  type WardForm,
} from './schemas';
import {
  useBuildings,
  useDeleteBuildingMutation,
  useDeleteManagerMutation,
  useDeleteStakeCallingTemplateMutation,
  useDeleteWardCallingTemplateMutation,
  useDeleteWardMutation,
  useManagers,
  useStakeCallingTemplates,
  useStakeDoc,
  useUpdateStakeConfigMutation,
  useUpsertBuildingMutation,
  useUpsertManagerMutation,
  useUpsertStakeCallingTemplateMutation,
  useUpsertWardCallingTemplateMutation,
  useUpsertWardMutation,
  useWardCallingTemplates,
  useWards,
} from './hooks';
import { Button } from '../../../components/ui/Button';
import { Dialog } from '../../../components/ui/Dialog';
import { Input } from '../../../components/ui/Input';
import { Select } from '../../../components/ui/Select';
import { LoadingSpinner } from '../../../lib/render/LoadingSpinner';
import { toast } from '../../../lib/store/toast';

export type ConfigTabKey =
  | 'config'
  | 'managers'
  | 'wards'
  | 'buildings'
  | 'ward-callings'
  | 'stake-callings';

const TABS: Array<{ key: ConfigTabKey; label: string }> = [
  { key: 'config', label: 'Config' },
  { key: 'managers', label: 'Managers' },
  { key: 'wards', label: 'Wards' },
  { key: 'buildings', label: 'Buildings' },
  { key: 'ward-callings', label: 'Auto Ward Callings' },
  { key: 'stake-callings', label: 'Auto Stake Callings' },
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
        Edit Wards, Buildings, Managers, Calling Templates, and stake-level config.
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
        {tab === 'ward-callings' ? <WardCallingsTab /> : null}
        {tab === 'stake-callings' ? <StakeCallingsTab /> : null}
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
}

function SectionHeader({ title, addLabel, onAdd, testid }: SectionHeaderProps) {
  return (
    <div className="kd-config-section-header">
      <h2>{title}</h2>
      <Button onClick={onAdd} data-testid={`${testid}-add-button`}>
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

  return (
    <div className="kd-config-section">
      <SectionHeader
        title="Wards"
        addLabel="Add Ward"
        onAdd={() => setOpenMode('add')}
        testid="config-wards"
      />
      <ul className="kd-config-rows" data-testid="config-wards-list">
        {sorted.map((w) => (
          <li key={w.ward_code}>
            <span>
              <strong>
                {w.ward_name} ({w.ward_code})
              </strong>{' '}
              — building: {w.building_name} · cap {w.seat_cap}
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
        onSubmit={async (input) => {
          await upsert.mutateAsync(input);
          toast('Ward saved.', 'success');
        }}
        onClose={() => setOpenMode('closed')}
      />
    </div>
  );
}

interface WardFormDialogProps {
  mode: 'closed' | 'add' | { kind: 'edit'; ward: Ward };
  buildingOptions: readonly Building[];
  isPending: boolean;
  onSubmit: (input: WardForm) => Promise<void>;
  onClose: () => void;
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
    defaultValues: editingWard
      ? {
          ward_code: editingWard.ward_code,
          ward_name: editingWard.ward_name,
          building_name: editingWard.building_name,
          seat_cap: editingWard.seat_cap,
        }
      : { ward_code: '', ward_name: '', building_name: '', seat_cap: 20 },
  });
  const { register, handleSubmit, reset, formState } = form;

  // Reset whenever the dialog flips open/closed or the editing target
  // changes — RHF doesn't automatically re-pick up new defaultValues.
  useEffect(() => {
    if (!open) return;
    reset(
      editingWard
        ? {
            ward_code: editingWard.ward_code,
            ward_name: editingWard.ward_name,
            building_name: editingWard.building_name,
            seat_cap: editingWard.seat_cap,
          }
        : { ward_code: '', ward_name: '', building_name: '', seat_cap: 20 },
    );
  }, [open, editingWard, reset]);

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
      title={isEdit ? `Edit ward — ${editingWard?.ward_code ?? ''}` : 'Add ward'}
    >
      <form onSubmit={submit} className="kd-wizard-form" data-testid="config-ward-form">
        <label>
          Ward code
          <Input
            {...register('ward_code')}
            maxLength={8}
            placeholder="CO"
            readOnly={isEdit}
            aria-readonly={isEdit}
          />
        </label>
        {formState.errors.ward_code ? (
          <p role="alert" className="kd-form-error">
            {formState.errors.ward_code.message}
          </p>
        ) : null}
        <label>
          Ward name
          <Input {...register('ward_name')} placeholder="Cordera Ward" />
        </label>
        {formState.errors.ward_name ? (
          <p role="alert" className="kd-form-error">
            {formState.errors.ward_name.message}
          </p>
        ) : null}
        <label>
          Building
          <Select {...register('building_name')}>
            <option value="">— Select —</option>
            {buildingOptions.map((b) => (
              <option key={b.building_id} value={b.building_name}>
                {b.building_name}
              </option>
            ))}
          </Select>
        </label>
        {formState.errors.building_name ? (
          <p role="alert" className="kd-form-error">
            {formState.errors.building_name.message}
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

  return (
    <div className="kd-config-section">
      <SectionHeader
        title="Buildings"
        addLabel="Add Building"
        onAdd={() => setOpenMode('add')}
        testid="config-buildings"
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
                onClick={() => setOpenMode({ kind: 'edit', building: b })}
                data-testid={`config-building-edit-${b.building_id}`}
              >
                Edit
              </Button>
              <Button
                variant="danger"
                onClick={() =>
                  del
                    .mutateAsync({
                      buildingId: b.building_id,
                      buildingName: b.building_name,
                      wards: wards.data ?? [],
                    })
                    .then(() => toast('Building deleted.', 'success'))
                    .catch((err) => toast(errorMessage(err), 'error'))
                }
                data-testid={`config-building-delete-${b.building_id}`}
              >
                Delete
              </Button>
            </span>
          </li>
        ))}
      </ul>

      <BuildingFormDialog
        mode={openMode}
        isPending={upsert.isPending}
        onSubmit={async (input) => {
          await upsert.mutateAsync(input);
          toast('Building saved.', 'success');
        }}
        onClose={() => setOpenMode('closed')}
      />
    </div>
  );
}

interface BuildingFormDialogProps {
  mode: 'closed' | 'add' | { kind: 'edit'; building: Building };
  isPending: boolean;
  onSubmit: (input: BuildingForm) => Promise<void>;
  onClose: () => void;
}

function BuildingFormDialog({ mode, isPending, onSubmit, onClose }: BuildingFormDialogProps) {
  const isEdit = typeof mode === 'object' && mode.kind === 'edit';
  const editingBuilding = isEdit ? mode.building : null;
  const open = mode !== 'closed';

  const form = useForm<BuildingForm>({
    resolver: zodResolver(buildingSchema),
    defaultValues: editingBuilding
      ? { building_name: editingBuilding.building_name, address: editingBuilding.address ?? '' }
      : { building_name: '', address: '' },
  });
  const { register, handleSubmit, reset, formState } = form;

  useEffect(() => {
    if (!open) return;
    reset(
      editingBuilding
        ? { building_name: editingBuilding.building_name, address: editingBuilding.address ?? '' }
        : { building_name: '', address: '' },
    );
  }, [open, editingBuilding, reset]);

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
      title={isEdit ? `Edit building — ${editingBuilding?.building_name ?? ''}` : 'Add building'}
    >
      <form onSubmit={submit} className="kd-wizard-form" data-testid="config-building-form">
        <label>
          Name
          <Input {...register('building_name')} placeholder="Cordera Building" />
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

// ---- Calling templates (ward + stake) -------------------------------

function WardCallingsTab() {
  const templates = useWardCallingTemplates();
  const upsert = useUpsertWardCallingTemplateMutation();
  const del = useDeleteWardCallingTemplateMutation();
  return (
    <CallingTemplatesPanel
      title="Auto Ward Callings"
      addLabel="Add Ward Calling"
      testid="ward-callings"
      data={templates.data}
      onUpsert={upsert.mutateAsync}
      isPending={upsert.isPending}
      onDelete={del.mutateAsync}
      hint="Wildcards (`Counselor *`) are supported. Sheet order breaks ties between wildcard matches."
    />
  );
}

function StakeCallingsTab() {
  const templates = useStakeCallingTemplates();
  const upsert = useUpsertStakeCallingTemplateMutation();
  const del = useDeleteStakeCallingTemplateMutation();
  return (
    <CallingTemplatesPanel
      title="Auto Stake Callings"
      addLabel="Add Stake Calling"
      testid="stake-callings"
      data={templates.data}
      onUpsert={upsert.mutateAsync}
      isPending={upsert.isPending}
      onDelete={del.mutateAsync}
      hint="Same shape as ward callings; applied to the Stake tab of the LCR sheet."
    />
  );
}

interface CallingTemplatesPanelProps {
  title: string;
  addLabel: string;
  testid: string;
  data: readonly WardCallingTemplate[] | undefined;
  onUpsert: (input: CallingTemplateForm) => Promise<unknown>;
  isPending: boolean;
  onDelete: (callingName: string) => Promise<unknown>;
  hint: string;
}

function CallingTemplatesPanel({
  title,
  addLabel,
  testid,
  data,
  onUpsert,
  isPending,
  onDelete,
  hint,
}: CallingTemplatesPanelProps) {
  const [open, setOpen] = useState(false);

  const sorted = useMemo(
    () => [...(data ?? [])].sort((a, b) => a.sheet_order - b.sheet_order),
    [data],
  );

  return (
    <div className="kd-config-section">
      <SectionHeader
        title={title}
        addLabel={addLabel}
        onAdd={() => setOpen(true)}
        testid={`config-${testid}`}
      />
      <p className="kd-form-hint">{hint}</p>
      <ul className="kd-config-rows" data-testid={`config-${testid}-list`}>
        {sorted.map((t) => (
          <li key={t.calling_name}>
            <span>
              <code>{t.calling_name}</code>
              {' · '}
              {t.give_app_access ? 'gives access' : 'no access'}
              {' · '}order {t.sheet_order}
            </span>
            <Button
              variant="danger"
              onClick={() =>
                onDelete(t.calling_name)
                  .then(() => toast('Template deleted.', 'success'))
                  .catch((err) => toast(errorMessage(err), 'error'))
              }
              data-testid={`config-${testid}-delete-${t.calling_name}`}
            >
              Delete
            </Button>
          </li>
        ))}
      </ul>

      <CallingTemplateFormDialog
        open={open}
        isPending={isPending}
        testid={testid}
        onSubmit={async (input) => {
          await onUpsert(input);
          toast('Calling template saved.', 'success');
        }}
        onClose={() => setOpen(false)}
      />
    </div>
  );
}

interface CallingTemplateFormDialogProps {
  open: boolean;
  isPending: boolean;
  testid: string;
  onSubmit: (input: CallingTemplateForm) => Promise<void>;
  onClose: () => void;
}

function CallingTemplateFormDialog({
  open,
  isPending,
  testid,
  onSubmit,
  onClose,
}: CallingTemplateFormDialogProps) {
  const form = useForm<CallingTemplateForm>({
    resolver: zodResolver(callingTemplateSchema),
    defaultValues: { calling_name: '', give_app_access: true, sheet_order: 0 },
  });
  const { register, handleSubmit, reset, formState } = form;

  useEffect(() => {
    if (!open) return;
    reset({ calling_name: '', give_app_access: true, sheet_order: 0 });
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
      title="Add calling template"
    >
      <form onSubmit={submit} className="kd-wizard-form" data-testid={`config-${testid}-form`}>
        <label>
          Calling name
          <Input {...register('calling_name')} placeholder="Bishop or Counselor *" />
        </label>
        {formState.errors.calling_name ? (
          <p role="alert" className="kd-form-error">
            {formState.errors.calling_name.message}
          </p>
        ) : null}
        <label>
          <input type="checkbox" {...register('give_app_access')} /> Give app access
        </label>
        <label>
          Sheet order
          <Input type="number" {...register('sheet_order', { valueAsNumber: true })} />
        </label>
        <Dialog.Footer>
          <Dialog.CancelButton>Cancel</Dialog.CancelButton>
          <Button type="submit" disabled={isPending} data-testid={`config-${testid}-submit`}>
            {isPending ? 'Saving…' : 'Create template'}
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
      callings_sheet_id: s?.callings_sheet_id ?? '',
      stake_seat_cap: s?.stake_seat_cap ?? 0,
      expiry_hour: s?.expiry_hour ?? 4,
      import_day: s?.import_day ?? 'MONDAY',
      import_hour: s?.import_hour ?? 6,
      timezone: s?.timezone ?? 'America/Denver',
      notifications_enabled: s?.notifications_enabled ?? true,
    };
  }, [stake.data]);

  const form = useForm<ConfigForm>({
    resolver: zodResolver(configSchema),
    values: defaults,
  });
  const { register, handleSubmit, formState } = form;

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
        Callings sheet ID
        <Input {...register('callings_sheet_id')} />
      </label>
      <label>
        Stake seat cap
        <Input type="number" min={0} {...register('stake_seat_cap', { valueAsNumber: true })} />
      </label>
      <label>
        Expiry hour (0–23)
        <Input
          type="number"
          min={0}
          max={23}
          {...register('expiry_hour', { valueAsNumber: true })}
        />
      </label>
      <label>
        Import day
        <Select {...register('import_day')}>
          {(
            ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'] as const
          ).map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </Select>
      </label>
      <label>
        Import hour (0–23)
        <Input
          type="number"
          min={0}
          max={23}
          {...register('import_hour', { valueAsNumber: true })}
        />
      </label>
      <label>
        Timezone (IANA, e.g. America/Denver)
        <Input {...register('timezone')} />
      </label>
      <label>
        <input type="checkbox" {...register('notifications_enabled')} /> Email Notifications
        Enabled
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
