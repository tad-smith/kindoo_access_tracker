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
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { Building, StakeCallingTemplate, Ward, WardCallingTemplate } from '@kindoo/shared';
import {
  buildingSchema,
  configSchema,
  managerSchema,
  wardSchema,
  type BuildingForm,
  type ConfigForm,
  type ManagerForm,
  type WardForm,
} from './schemas';
import {
  useAddStakeCallingTemplateMutation,
  useAddWardCallingTemplateMutation,
  useBuildings,
  useDeleteBuildingMutation,
  useDeleteManagerMutation,
  useDeleteStakeCallingTemplateWithResequenceMutation,
  useDeleteWardCallingTemplateWithResequenceMutation,
  useDeleteWardMutation,
  useManagers,
  useReorderStakeCallingTemplatesMutation,
  useReorderWardCallingTemplatesMutation,
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
import { CallingTemplateFormDialog } from './CallingTemplateFormDialog';
import type { CallingTemplateDialogMode } from './CallingTemplateFormDialog';
import { CallingTemplatesTable } from './CallingTemplatesTable';
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
//
// Two tabs share the same table + dialog component. Order column NOT
// shown — implicit from row position; lower `sheet_order` renders
// higher. Drag-to-reorder is mouse + keyboard via @dnd-kit; touch goes
// through the per-row long-press path inside `CallingTemplatesTable`.

function WardCallingsTab() {
  const templates = useWardCallingTemplates();
  const add = useAddWardCallingTemplateMutation();
  const upsert = useUpsertWardCallingTemplateMutation();
  const del = useDeleteWardCallingTemplateWithResequenceMutation();
  const reorder = useReorderWardCallingTemplatesMutation();
  return (
    <CallingTemplatesPanel
      title="Auto Ward Callings"
      addLabel="Add Ward Calling"
      testid="ward-callings"
      data={templates.data}
      isPending={add.isPending || upsert.isPending}
      onAdd={async (input) => {
        await add.mutateAsync({
          calling_name: input.calling_name,
          give_app_access: input.give_app_access,
          auto_kindoo_access: input.auto_kindoo_access,
          existing: templates.data ?? [],
        });
        toast('Calling added.', 'success');
      }}
      onEdit={async (input) => {
        await upsert.mutateAsync({
          calling_name: input.calling_name,
          give_app_access: input.give_app_access,
          auto_kindoo_access: input.auto_kindoo_access,
          sheet_order: input.sheet_order,
        });
        toast('Calling saved.', 'success');
      }}
      onDelete={async (template) => {
        await del.mutateAsync({
          callingName: template.calling_name,
          current: templates.data ?? [],
        });
        toast('Calling deleted.', 'success');
      }}
      onReorder={async (orderedCallingNames) => {
        await reorder.mutateAsync({
          orderedCallingNames,
          current: templates.data ?? [],
        });
      }}
      hint="Wildcards (`Counselor *`) are supported. Sheet order breaks ties between wildcard matches. Drag rows to reorder."
    />
  );
}

function StakeCallingsTab() {
  const templates = useStakeCallingTemplates();
  const add = useAddStakeCallingTemplateMutation();
  const upsert = useUpsertStakeCallingTemplateMutation();
  const del = useDeleteStakeCallingTemplateWithResequenceMutation();
  const reorder = useReorderStakeCallingTemplatesMutation();
  return (
    <CallingTemplatesPanel
      title="Auto Stake Callings"
      addLabel="Add Stake Calling"
      testid="stake-callings"
      data={templates.data}
      isPending={add.isPending || upsert.isPending}
      onAdd={async (input) => {
        await add.mutateAsync({
          calling_name: input.calling_name,
          give_app_access: input.give_app_access,
          auto_kindoo_access: input.auto_kindoo_access,
          existing: templates.data ?? [],
        });
        toast('Calling added.', 'success');
      }}
      onEdit={async (input) => {
        await upsert.mutateAsync({
          calling_name: input.calling_name,
          give_app_access: input.give_app_access,
          auto_kindoo_access: input.auto_kindoo_access,
          sheet_order: input.sheet_order,
        });
        toast('Calling saved.', 'success');
      }}
      onDelete={async (template) => {
        await del.mutateAsync({
          callingName: template.calling_name,
          current: templates.data ?? [],
        });
        toast('Calling deleted.', 'success');
      }}
      onReorder={async (orderedCallingNames) => {
        await reorder.mutateAsync({
          orderedCallingNames,
          current: templates.data ?? [],
        });
      }}
      hint="Same shape as ward callings; applied to the Stake tab of the LCR sheet. Drag rows to reorder."
    />
  );
}

interface CallingTemplatesPanelProps {
  title: string;
  addLabel: string;
  testid: string;
  data: readonly (WardCallingTemplate | StakeCallingTemplate)[] | undefined;
  isPending: boolean;
  onAdd: (input: {
    calling_name: string;
    give_app_access: boolean;
    auto_kindoo_access: boolean;
    sheet_order: number;
  }) => Promise<void>;
  onEdit: (input: {
    calling_name: string;
    give_app_access: boolean;
    auto_kindoo_access: boolean;
    sheet_order: number;
  }) => Promise<void>;
  onDelete: (template: WardCallingTemplate) => Promise<void>;
  onReorder: (orderedCallingNames: string[]) => Promise<void>;
  hint: string;
}

function CallingTemplatesPanel({
  title,
  addLabel,
  testid,
  data,
  isPending,
  onAdd,
  onEdit,
  onDelete,
  onReorder,
  hint,
}: CallingTemplatesPanelProps) {
  const [mode, setMode] = useState<CallingTemplateDialogMode>('closed');

  const sorted = useMemo(
    () => [...(data ?? [])].sort((a, b) => a.sheet_order - b.sheet_order),
    [data],
  );

  return (
    <div className="kd-config-section">
      <SectionHeader
        title={title}
        addLabel={addLabel}
        onAdd={() => setMode('add')}
        testid={`config-${testid}`}
      />
      <p className="kd-form-hint">{hint}</p>
      <CallingTemplatesTable
        testid={testid}
        templates={sorted}
        onEdit={(t) => setMode({ kind: 'edit', template: t })}
        onDelete={(t) => onDelete(t).catch((err) => toast(errorMessage(err), 'error'))}
        onReorder={(orderedCallingNames) =>
          onReorder(orderedCallingNames).catch((err) => toast(errorMessage(err), 'error'))
        }
      />
      <CallingTemplateFormDialog
        mode={mode}
        isPending={isPending}
        testid={testid}
        onSubmitAdd={onAdd}
        onSubmitEdit={onEdit}
        onClose={() => setMode('closed')}
      />
    </div>
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
