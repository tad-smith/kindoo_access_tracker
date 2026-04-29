// Multi-step bootstrap wizard. Mirrors `src/ui/BootstrapWizard.html`
// from the Apps Script app; runs against the bootstrap admin's Firebase
// Auth account before they're a manager. The wizard's existence is
// gated by the `BootstrapGate` route component (a parent guard) so this
// page is only rendered when:
//
//   1. The user is signed in.
//   2. The stake doc has `setup_complete=false`.
//   3. The user's email matches `stake.bootstrap_admin_email`.
//
// Architecture mirrors the legacy four-step layout:
//
//   Step 1 — Stake fields (name + stake_seat_cap required;
//            callings_sheet_id optional).
//   Step 2 — ≥1 Building.
//   Step 3 — ≥1 Ward.
//   Step 4 — Additional Kindoo Managers (optional). Bootstrap admin
//            auto-added on first load.
//
// Each step writes to Firestore directly (no client-side pending
// queue). Navigation between steps is free (no forward-only flow); the
// "Complete Setup" button is enabled iff steps 1–3 are valid:
//   - stake.stake_name + stake_seat_cap set
//   - ≥1 building
//   - ≥1 ward
//
// Complete Setup flips `setup_complete=true`, optionally invokes the
// `installScheduledJobs` callable (Phase 8 stub — handled gracefully if
// the function isn't deployed), and lets the routing gate redirect the
// admin to `/manager/dashboard`. The `setup_complete=true` flip means a
// post-setup wizard reload is invisible (the gate skips it).

import { useEffect, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useNavigate } from '@tanstack/react-router';
import { ChevronRight } from 'lucide-react';
import {
  buildingSchema,
  managerSchema,
  step1Schema,
  wardSchema,
  type BuildingForm,
  type ManagerForm,
  type Step1Form,
  type WardForm,
} from './schemas';
import {
  useAddBuildingMutation,
  useAddManagerMutation,
  useAddWardMutation,
  useBuildings,
  useCompleteSetupMutation,
  useDeleteBuildingMutation,
  useDeleteManagerMutation,
  useDeleteWardMutation,
  useEnsureBootstrapAdmin,
  useManagers,
  useStakeDoc,
  useStep1Mutation,
  useUpdateManagerActiveMutation,
  useWards,
} from './hooks';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { Select } from '../../components/ui/Select';
import { LoadingSpinner } from '../../lib/render/LoadingSpinner';
import { toast } from '../../lib/store/toast';
import { canonicalEmail as canonicalEmailFn } from '@kindoo/shared';
import { usePrincipal } from '../../lib/principal';
import { invokeInstallScheduledJobs } from './callables';

type StepNumber = 1 | 2 | 3 | 4;

/** Friendly summary of a thrown rule denial / transaction failure. */
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export function BootstrapWizardPage() {
  const navigate = useNavigate();
  const principal = usePrincipal();
  const stake = useStakeDoc();
  const buildings = useBuildings();
  const wards = useWards();
  const managers = useManagers();
  const ensureAdmin = useEnsureBootstrapAdmin();

  const [step, setStep] = useState<StepNumber>(1);

  // Auto-add the bootstrap admin to kindooManagers on first wizard load
  // so the `syncManagersClaims` trigger mints the manager claim that
  // makes the rest of the wizard's writes pass the manager-rule
  // predicates. Run once when the stake doc + principal email both
  // resolve. Idempotent — `setDoc` with `merge: true` is safe to retry.
  const adminEmail = stake.data?.bootstrap_admin_email;
  const principalEmail = principal.email;
  useEffect(() => {
    if (!adminEmail || !principalEmail) return;
    if (canonicalEmailFn(principalEmail) !== canonicalEmailFn(adminEmail)) return;
    if (managers.data === undefined) return;
    const already = managers.data.some(
      (m) => m.member_canonical === canonicalEmailFn(adminEmail) && m.active,
    );
    if (already) return;
    ensureAdmin.mutateAsync(adminEmail).catch((err) => {
      toast(`Could not auto-add bootstrap admin: ${errorMessage(err)}`, 'error');
    });
    // adminEmail / principalEmail / managers.data are the trigger.
    // ensureAdmin is stable per-mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adminEmail, principalEmail, managers.data]);

  // callings_sheet_id is optional — only stake_name + stake_seat_cap
  // gate Step 1 completion.
  const step1Done = useMemo(() => {
    const s = stake.data;
    return Boolean(
      s && s.stake_name && typeof s.stake_seat_cap === 'number' && s.stake_seat_cap >= 0,
    );
  }, [stake.data]);
  const step2Done = (buildings.data?.length ?? 0) > 0;
  const step3Done = (wards.data?.length ?? 0) > 0;
  const canFinish = step1Done && step2Done && step3Done;

  // The outer wrapper carries `data-testid="bootstrap-wizard"`
  // unconditionally so route-routing tests can assert "we landed on the
  // wizard" before the inner content has hydrated. While the stake
  // doc's snapshot is still in flight (the parent gate already saw
  // `setup_complete=false`, so this is a brief same-key cache warmup),
  // we render the spinner inside the wrapper rather than swapping the
  // testid host out from under the test.
  if (stake.isLoading || stake.data === undefined) {
    return (
      <main className="kd-bootstrap-wizard" data-testid="bootstrap-wizard">
        <h1>Set up Stake Building Access</h1>
        <LoadingSpinner />
      </main>
    );
  }

  return (
    <main className="kd-bootstrap-wizard" data-testid="bootstrap-wizard">
      <h1>Set up Stake Building Access</h1>
      <p className="kd-page-subtitle">
        This four-step wizard configures your stake for the first time. You can revisit any
        completed step. Each row saves immediately when you click Add.
      </p>

      <StepIndicator
        steps={[
          { num: 1, label: 'Stake', done: step1Done },
          { num: 2, label: 'Buildings', done: step2Done },
          { num: 3, label: 'Wards', done: step3Done },
          { num: 4, label: 'Managers', done: true },
        ]}
        current={step}
        onSelect={(n) => setStep(n)}
        completeDone={canFinish}
      />

      <section className="kd-wizard-panel" data-testid={`wizard-step-${step}`}>
        {step === 1 ? <Step1Form /> : null}
        {step === 2 ? <Step2Buildings /> : null}
        {step === 3 ? <Step3Wards /> : null}
        {step === 4 ? <Step4Managers /> : null}
      </section>

      {/* Button row + blocker list stack vertically so the blocker
          helper does not push the Next button leftward. The buttons sit
          on their own row; the helper text renders below the row. */}
      <div className="kd-wizard-finish-stack">
        <div className="kd-wizard-finish">
          {step > 1 ? (
            <Button variant="secondary" onClick={() => setStep((s) => (s - 1) as StepNumber)}>
              Back
            </Button>
          ) : null}
          {step < 4 ? (
            <Button onClick={() => setStep((s) => (s + 1) as StepNumber)}>Next</Button>
          ) : null}
          <CompleteSetupButton
            enabled={canFinish}
            onCompleted={() => {
              // Navigation back to / lets the routing gate redirect to
              // the manager default landing page now that
              // setup_complete=true.
              navigate({ to: '/', replace: true }).catch(() => {});
            }}
          />
        </div>
        <CompleteSetupBlockers missing={completionBlockers({ step1Done, step2Done, step3Done })} />
      </div>
    </main>
  );
}

// Mirrors the disabled-state check on the Complete Setup button. Returned
// list is empty iff the button is enabled. Drives the helper text below
// the button so the user knows exactly what's blocking finalisation.
export function completionBlockers(args: {
  step1Done: boolean;
  step2Done: boolean;
  step3Done: boolean;
}): string[] {
  const out: string[] = [];
  if (!args.step1Done) out.push('Fill in stake name and seat cap (Step 1).');
  if (!args.step2Done) out.push('Add at least one building (Step 2).');
  if (!args.step3Done) out.push('Add at least one ward (Step 3).');
  return out;
}

interface StepIndicatorProps {
  steps: ReadonlyArray<{ num: StepNumber; label: string; done: boolean }>;
  current: StepNumber;
  onSelect: (n: StepNumber) => void;
  /** True iff every wizard step is satisfied — drives the trailing "Complete" pill. */
  completeDone: boolean;
}

// Chevron-arrow stepper. Labels only (no numbers); green when the
// step's validation passes, neutral otherwise, slightly highlighted
// for the current step. The trailing "Complete" pill turns green only
// when every prior step is done.
function StepIndicator({ steps, current, onSelect, completeDone }: StepIndicatorProps) {
  return (
    <nav
      role="tablist"
      aria-label="Bootstrap steps"
      className="flex flex-wrap items-center gap-1 sm:gap-2 my-4"
    >
      {steps.map((s, idx) => {
        const isCurrent = current === s.num;
        return (
          <span key={s.num} className="flex items-center gap-1 sm:gap-2">
            <button
              type="button"
              role="tab"
              aria-selected={isCurrent}
              aria-current={isCurrent ? 'step' : undefined}
              onClick={() => onSelect(s.num)}
              data-testid={`wizard-step-tab-${s.num}`}
              data-step-done={s.done ? 'true' : 'false'}
              className={
                'inline-flex items-center px-3 py-1.5 text-sm rounded transition-colors ' +
                'border ' +
                (s.done
                  ? 'border-kd-success-br bg-kd-success-tint text-kd-success-fg hover:bg-kd-success-bg '
                  : 'border-gray-300 bg-white text-gray-700 hover:bg-gray-50 ') +
                (isCurrent ? 'ring-2 ring-kd-primary ring-offset-1 font-semibold ' : '')
              }
            >
              {s.label}
            </button>
            {idx < steps.length - 1 ? <StepChevron /> : null}
          </span>
        );
      })}
      <StepChevron />
      <span
        aria-hidden={!completeDone}
        data-testid="wizard-step-complete-pill"
        data-step-done={completeDone ? 'true' : 'false'}
        className={
          'inline-flex items-center px-3 py-1.5 text-sm rounded border ' +
          (completeDone
            ? 'border-kd-success-br bg-kd-success-tint text-kd-success-fg'
            : 'border-gray-300 bg-white text-gray-500')
        }
      >
        Complete
      </span>
    </nav>
  );
}

// Breadcrumb-style chevron between wizard steps. Lucide's ChevronRight
// is a stroked `>` glyph (not a filled arrowhead) — matches the
// browser-breadcrumb / wizard-step visual the operator asked for.
function StepChevron() {
  return <ChevronRight aria-hidden className="h-4 w-4 shrink-0 text-gray-400" />;
}

// ---- Step 1 — Stake fields ------------------------------------------

function Step1Form() {
  const stake = useStakeDoc();
  const mutation = useStep1Mutation();
  const form = useForm<Step1Form>({
    resolver: zodResolver(step1Schema),
    defaultValues: {
      stake_name: stake.data?.stake_name ?? '',
      callings_sheet_id: stake.data?.callings_sheet_id ?? '',
      stake_seat_cap: stake.data?.stake_seat_cap ?? 0,
    },
    ...(stake.data
      ? {
          values: {
            stake_name: stake.data.stake_name ?? '',
            callings_sheet_id: stake.data.callings_sheet_id ?? '',
            stake_seat_cap: stake.data.stake_seat_cap ?? 0,
          },
        }
      : {}),
  });
  const { register, handleSubmit, formState } = form;

  async function onSubmit(input: Step1Form) {
    try {
      await mutation.mutateAsync(input);
      toast('Stake settings saved.', 'success');
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  }

  return (
    <form className="kd-wizard-form" onSubmit={handleSubmit(onSubmit)}>
      <h2>Stake settings</h2>
      <label>
        Stake name
        <Input {...register('stake_name')} placeholder="My Stake" />
      </label>
      {formState.errors.stake_name ? (
        <p role="alert" className="kd-form-error">
          {formState.errors.stake_name.message}
        </p>
      ) : null}
      <label>
        Callings-sheet ID <span className="kd-form-hint">(optional)</span>
        <Input {...register('callings_sheet_id')} placeholder="1A2B3C..." />
      </label>
      <label>
        Stake seat cap
        <Input type="number" min={0} {...register('stake_seat_cap', { valueAsNumber: true })} />
      </label>
      {formState.errors.stake_seat_cap ? (
        <p role="alert" className="kd-form-error">
          {formState.errors.stake_seat_cap.message}
        </p>
      ) : null}
      <div className="form-actions">
        <Button type="submit" disabled={mutation.isPending || formState.isSubmitting}>
          {mutation.isPending ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </form>
  );
}

// ---- Step 2 — Buildings ---------------------------------------------

function Step2Buildings() {
  const buildings = useBuildings();
  const addMutation = useAddBuildingMutation();
  const deleteMutation = useDeleteBuildingMutation();

  const form = useForm<BuildingForm>({
    resolver: zodResolver(buildingSchema),
    defaultValues: { building_name: '', address: '' },
  });
  const { register, handleSubmit, reset, formState } = form;

  async function onAdd(input: BuildingForm) {
    try {
      await addMutation.mutateAsync(input);
      reset();
      toast('Building added.', 'success');
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  }

  return (
    <div className="kd-wizard-form">
      <h2>Buildings</h2>
      <p>Add at least one building. The Wards step references buildings by name.</p>
      <ul className="kd-wizard-row-list" data-testid="bootstrap-buildings-list">
        {(buildings.data ?? []).map((b) => (
          <li key={b.building_id}>
            <span>
              <strong>{b.building_name}</strong>
              {b.address ? <> — {b.address}</> : null}
            </span>
            <Button
              variant="danger"
              onClick={() => {
                deleteMutation
                  .mutateAsync({ buildingId: b.building_id, buildingName: b.building_name })
                  .then(() => toast('Building deleted.', 'success'))
                  .catch((err) => toast(errorMessage(err), 'error'));
              }}
              data-testid={`bootstrap-building-delete-${b.building_id}`}
            >
              Delete
            </Button>
          </li>
        ))}
      </ul>
      <form onSubmit={handleSubmit(onAdd)}>
        <label>
          Building name
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
        <div className="form-actions">
          <Button type="submit" disabled={addMutation.isPending}>
            {addMutation.isPending ? 'Adding…' : 'Add building'}
          </Button>
        </div>
      </form>
    </div>
  );
}

// ---- Step 3 — Wards -------------------------------------------------

function Step3Wards() {
  const wards = useWards();
  const buildings = useBuildings();
  const addMutation = useAddWardMutation();
  const deleteMutation = useDeleteWardMutation();

  const form = useForm<WardForm>({
    resolver: zodResolver(wardSchema),
    defaultValues: { ward_code: '', ward_name: '', building_name: '', seat_cap: 20 },
  });
  const { register, handleSubmit, reset, formState } = form;

  async function onAdd(input: WardForm) {
    try {
      await addMutation.mutateAsync(input);
      reset();
      toast('Ward added.', 'success');
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  }

  const buildingOptions = buildings.data ?? [];

  return (
    <div className="kd-wizard-form">
      <h2>Wards</h2>
      <p>Add at least one ward. Each ward maps to one of the buildings you set up in Step 2.</p>
      <ul className="kd-wizard-row-list" data-testid="bootstrap-wards-list">
        {(wards.data ?? []).map((w) => (
          <li key={w.ward_code}>
            <span>
              <strong>
                {w.ward_name} ({w.ward_code})
              </strong>{' '}
              — building: {w.building_name} · cap {w.seat_cap}
            </span>
            <Button
              variant="danger"
              onClick={() => {
                deleteMutation
                  .mutateAsync(w.ward_code)
                  .then(() => toast('Ward deleted.', 'success'))
                  .catch((err) => toast(errorMessage(err), 'error'));
              }}
              data-testid={`bootstrap-ward-delete-${w.ward_code}`}
            >
              Delete
            </Button>
          </li>
        ))}
      </ul>
      <form onSubmit={handleSubmit(onAdd)}>
        <label>
          Ward code
          <Input {...register('ward_code')} placeholder="CO" maxLength={8} />
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
            <option value="">— Select a building —</option>
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
        <div className="form-actions">
          <Button type="submit" disabled={addMutation.isPending || buildingOptions.length === 0}>
            {addMutation.isPending ? 'Adding…' : 'Add ward'}
          </Button>
        </div>
        {buildingOptions.length === 0 ? (
          <p className="kd-form-hint">Add a building first (Step 2) before adding wards.</p>
        ) : null}
      </form>
    </div>
  );
}

// ---- Step 4 — Managers ----------------------------------------------

function Step4Managers() {
  const managers = useManagers();
  const stake = useStakeDoc();
  const addMutation = useAddManagerMutation();
  const updateMutation = useUpdateManagerActiveMutation();
  const deleteMutation = useDeleteManagerMutation();

  const adminCanonical = useMemo(
    () =>
      stake.data?.bootstrap_admin_email ? canonicalEmailFn(stake.data.bootstrap_admin_email) : '',
    [stake.data?.bootstrap_admin_email],
  );

  const form = useForm<ManagerForm>({
    resolver: zodResolver(managerSchema),
    defaultValues: { member_email: '', name: '' },
  });
  const { register, handleSubmit, reset, formState } = form;

  async function onAdd(input: ManagerForm) {
    try {
      await addMutation.mutateAsync(input);
      reset();
      toast('Manager added.', 'success');
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  }

  return (
    <div className="kd-wizard-form">
      <h2>Kindoo Managers</h2>
      <p>
        Optional. The bootstrap admin is auto-added and can&rsquo;t be deleted or deactivated from
        this step (deactivating themselves would lock them out). Additional managers can also be
        added later from the Configuration page.
      </p>
      <ul className="kd-wizard-row-list" data-testid="bootstrap-managers-list">
        {(managers.data ?? []).map((m) => {
          const isAdmin = m.member_canonical === adminCanonical;
          return (
            <li key={m.member_canonical}>
              <span>
                <strong>{m.name || m.member_email}</strong> <code>{m.member_email}</code>
                {!m.active ? <em> (inactive)</em> : null}
                {isAdmin ? <em> (bootstrap admin)</em> : null}
              </span>
              {/* The bootstrap admin row hides BOTH the deactivate and the
                  delete actions — deactivating or removing themselves
                  would lock them out of the wizard mid-setup. */}
              {isAdmin ? null : (
                <span className="inline-flex gap-2">
                  <Button
                    variant="secondary"
                    onClick={() => {
                      updateMutation
                        .mutateAsync({ canonical: m.member_canonical, active: !m.active })
                        .then(() => toast('Manager updated.', 'success'))
                        .catch((err) => toast(errorMessage(err), 'error'));
                    }}
                    data-testid={`bootstrap-manager-toggle-${m.member_canonical}`}
                  >
                    {m.active ? 'Deactivate' : 'Activate'}
                  </Button>
                  <Button
                    variant="danger"
                    onClick={() => {
                      deleteMutation
                        .mutateAsync(m.member_canonical)
                        .then(() => toast('Manager removed.', 'success'))
                        .catch((err) => toast(errorMessage(err), 'error'));
                    }}
                    data-testid={`bootstrap-manager-delete-${m.member_canonical}`}
                  >
                    Delete
                  </Button>
                </span>
              )}
            </li>
          );
        })}
      </ul>
      <form onSubmit={handleSubmit(onAdd)}>
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
        <div className="form-actions">
          <Button type="submit" disabled={addMutation.isPending}>
            {addMutation.isPending ? 'Adding…' : 'Add manager'}
          </Button>
        </div>
      </form>
    </div>
  );
}

interface CompleteSetupProps {
  enabled: boolean;
  onCompleted: () => void;
}

function CompleteSetupButton({ enabled, onCompleted }: CompleteSetupProps) {
  const mutation = useCompleteSetupMutation();

  async function complete() {
    try {
      await mutation.mutateAsync();
      // Best-effort callable — Phase 8 ships the function. If it isn't
      // deployed yet we surface a warn-toast but the setup completion
      // is not rolled back.
      try {
        await invokeInstallScheduledJobs();
      } catch (callErr) {
        toast(
          `Setup complete, but scheduled-jobs install warned: ${errorMessage(callErr)}`,
          'warn',
        );
      }
      toast('Setup complete!', 'success');
      onCompleted();
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  }

  return (
    <Button
      variant="success"
      onClick={complete}
      disabled={!enabled || mutation.isPending}
      data-testid="bootstrap-complete-setup"
    >
      {mutation.isPending ? 'Completing…' : 'Complete Setup'}
    </Button>
  );
}

// Renders the blocker list below the button row when the wizard is not
// yet finishable. Empty list → nothing rendered, so the row collapses.
function CompleteSetupBlockers({ missing }: { missing: string[] }) {
  if (missing.length === 0) return null;
  return (
    <ul
      className="kd-form-hint list-none p-0 m-0 text-right"
      data-testid="bootstrap-complete-blockers"
    >
      {missing.map((m) => (
        <li key={m}>{m}</li>
      ))}
    </ul>
  );
}
