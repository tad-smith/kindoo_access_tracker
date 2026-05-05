// `NewRequestForm` — the shared add_manual / add_temp form rendered on
// `/bishopric/new` and `/stake/new`. Mirrors `src/ui/NewRequest.html`
// from the Apps Script app. Forks per role solely on which scopes are
// available (single role → implicit scope; multi-role → dropdown);
// every other behaviour is identical between roles.
//
// Field set:
//   - Request type (add_manual / add_temp)
//   - Dates (add_temp only — shown directly under the type selector)
//   - Member email (required)
//   - Member name (required client + server)
//   - Reason (required)
//   - Comment (free-form)
//   - Buildings — collapsible checkbox group with role-aware defaults:
//     ward users see a collapsed header pre-populated with their
//     ward's building (multi-ward: one per ward); stake users see the
//     panel expanded with no defaults. Either role can expand and
//     check additional buildings — the legacy "ward users get one
//     ward's building only" restriction is gone.
//
// Cross-cutting behaviour:
//   - `Requesting for:` label / dropdown above the form.
//   - Inline duplicate warning when a seat already exists for the
//     entered member in the chosen scope (live via `useSeatForMember`).
//   - Submit writes a request doc; success → toast + form reset.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { canonicalEmail } from '@kindoo/shared';
import type { Building, Seat, Ward } from '@kindoo/shared';
import { newRequestSchema, type NewRequestForm } from '../schemas';
import { useSubmitRequest, useSeatForMember } from '../hooks';
import { Input } from '../../../components/ui/Input';
import { Select } from '../../../components/ui/Select';
import { Button } from '../../../components/ui/Button';
import { Badge } from '../../../components/ui/Badge';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '../../../components/ui/Collapsible';
import { toast } from '../../../lib/store/toast';

export interface ScopeOption {
  /** `'stake'` or a ward_code. */
  value: string;
  /** Human label, e.g. `'Stake'` or `'Ward CO'`. */
  label: string;
}

export interface NewRequestFormProps {
  /** Scopes the principal may submit against. ≥1; ordering = display order. */
  scopes: ScopeOption[];
  /** Buildings catalogue — the full checkbox list shown when the
   *  selector is expanded. Same source for ward and stake users. */
  buildings: readonly Building[];
  /** Wards catalogue. Used to compute the default-selected buildings
   *  for ward users from each of their wards' `building_name` fields.
   *  Empty when no wards are loaded yet → defaults fall back to empty
   *  and the manager picks at completion. */
  wards: readonly Ward[];
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Default-select the buildings tied to the principal's ward scopes.
 * Stake-only users get an empty default; ward users get one entry per
 * ward they hold a bishopric role in (deduped). Names that match a
 * `Ward.building_name` but no `Building` doc still flow through — the
 * manager will see them at completion time.
 */
function defaultBuildingsFor(scopes: readonly ScopeOption[], wards: readonly Ward[]): string[] {
  const wardCodes = new Set(scopes.filter((s) => s.value !== 'stake').map((s) => s.value));
  if (wardCodes.size === 0) return [];
  const out: string[] = [];
  for (const ward of wards) {
    if (!wardCodes.has(ward.ward_code)) continue;
    const name = ward.building_name;
    if (!name || out.includes(name)) continue;
    out.push(name);
  }
  return out;
}

function buildingsHeaderLabel(selected: readonly string[]): string {
  if (selected.length === 0) return 'No buildings selected';
  const word = selected.length === 1 ? 'Building' : 'Buildings';
  return `${word}: ${selected.join(', ')}`;
}

export function NewRequestForm({ scopes, buildings, wards }: NewRequestFormProps) {
  const submit = useSubmitRequest();
  const initialScope = scopes[0]?.value ?? '';
  const hasStake = useMemo(() => scopes.some((s) => s.value === 'stake'), [scopes]);

  // Default-collapsed for ward-only users; default-expanded for any
  // user who can submit at stake scope (today's UX). The operator can
  // toggle freely once the form mounts.
  const [buildingsOpen, setBuildingsOpen] = useState<boolean>(hasStake);

  // Initial default selection — captured once on mount so that user
  // edits (deselects, additions) survive scope-dropdown toggles. Empty
  // when scopes are empty; recomputed lazily inside the form's
  // `defaultValues`.
  const initialBuildings = useMemo(
    () => defaultBuildingsFor(scopes, wards),
    // We DO want this to recompute if `wards` arrives after first
    // render (see the wards-late effect below); the form's
    // `defaultValues` is captured once so updates flow through that
    // effect, not through `reset`.
    [scopes, wards],
  );

  const form = useForm<NewRequestForm>({
    resolver: zodResolver(newRequestSchema),
    defaultValues: {
      type: 'add_manual',
      scope: initialScope,
      member_email: '',
      member_name: '',
      reason: '',
      comment: '',
      start_date: '',
      end_date: '',
      building_names: initialBuildings,
      urgent: false,
    },
  });
  const { register, handleSubmit, reset, watch, setValue, formState } = form;
  const watchedType = watch('type');
  const watchedScope = watch('scope');
  const watchedEmail = watch('member_email');
  const watchedBuildings = watch('building_names') ?? [];
  const watchedUrgent = watch('urgent');

  // If `wards` arrives after the form mounted (live subscription), and
  // the user has not yet touched the buildings field, apply the
  // computed defaults once. `formState.dirtyFields.building_names` is
  // the react-hook-form signal that the user has edited the list;
  // respect it and bail.
  const wardsHydrated = useRef(false);
  useEffect(() => {
    if (wardsHydrated.current) return;
    if (formState.dirtyFields.building_names) return;
    if (initialBuildings.length === 0) return;
    setValue('building_names', initialBuildings, { shouldDirty: false, shouldValidate: false });
    wardsHydrated.current = true;
  }, [initialBuildings, formState.dirtyFields.building_names, setValue]);

  // Live duplicate-warning. The seat doc id is the canonical email, so
  // we can subscribe directly without a query. Strip whitespace + run
  // canonicalisation client-side; the subscription disables itself
  // when the email is too short to be plausible.
  const dupCanonical = useMemo(() => {
    const trimmed = (watchedEmail ?? '').trim();
    if (trimmed.length < 3 || !trimmed.includes('@')) return null;
    return canonicalEmail(trimmed);
  }, [watchedEmail]);
  const dupSeatResult = useSeatForMember(dupCanonical);
  const dupSeat = dupSeatResult.data ?? null;
  const dupHit = useMemo<Seat | null>(() => {
    if (!dupSeat) return null;
    if (dupSeat.scope === watchedScope) return dupSeat;
    // Cross-scope hits also count — the spec says "warn when the member
    // has any seat in the selected scope". A duplicate-grants entry on
    // the seat that targets `watchedScope` counts too.
    if ((dupSeat.duplicate_grants ?? []).some((g) => g.scope === watchedScope)) return dupSeat;
    return null;
  }, [dupSeat, watchedScope]);

  const onSubmit = handleSubmit(async (input) => {
    try {
      await submit.mutateAsync({
        type: input.type,
        scope: input.scope,
        member_email: input.member_email,
        member_name: input.member_name,
        reason: input.reason,
        comment: input.comment,
        start_date: input.start_date,
        end_date: input.end_date,
        building_names: input.building_names,
        urgent: input.urgent,
      });
      toast('Request submitted.', 'success');
      // Reset clears user edits, so re-apply the role-aware defaults
      // for buildings; otherwise a single-ward bishop would lose the
      // pre-checked ward building between submissions.
      reset({
        type: 'add_manual',
        scope: input.scope,
        member_email: '',
        member_name: '',
        reason: '',
        comment: '',
        start_date: '',
        end_date: '',
        building_names: defaultBuildingsFor(scopes, wards),
        urgent: false,
      });
      wardsHydrated.current = true;
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  });

  if (scopes.length === 0) {
    return (
      <p className="kd-form-error" role="alert">
        You don&apos;t hold a bishopric or stake role. Only those roles may submit new requests.
      </p>
    );
  }

  return (
    <form className="kd-wizard-form" onSubmit={onSubmit} data-testid="new-request-form" noValidate>
      <div className="kd-page-subtitle">
        {scopes.length === 1 ? (
          <>
            <strong>Requesting for:</strong> {scopes[0]?.label}
          </>
        ) : (
          <label>
            <strong>Requesting for:</strong>{' '}
            <Select {...register('scope')} data-testid="new-request-scope">
              {scopes.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </Select>
          </label>
        )}
      </div>

      <label>
        Request type
        <Select {...register('type')} data-testid="new-request-type">
          <option value="add_manual">Manual (ongoing)</option>
          <option value="add_temp">Temporary (dated)</option>
        </Select>
      </label>

      {watchedType === 'add_temp' ? (
        <div className="kd-temp-fields">
          <label>
            Start date
            <Input type="date" {...register('start_date')} data-testid="new-request-start-date" />
          </label>
          {formState.errors.start_date ? (
            <p className="kd-form-error" role="alert">
              {formState.errors.start_date.message}
            </p>
          ) : null}
          <label>
            End date
            <Input type="date" {...register('end_date')} data-testid="new-request-end-date" />
          </label>
          {formState.errors.end_date ? (
            <p className="kd-form-error" role="alert">
              {formState.errors.end_date.message}
            </p>
          ) : null}
        </div>
      ) : null}

      <label>
        Member email
        <Input
          type="email"
          autoComplete="off"
          {...register('member_email')}
          data-testid="new-request-email"
        />
      </label>
      {formState.errors.member_email ? (
        <p className="kd-form-error" role="alert">
          {formState.errors.member_email.message}
        </p>
      ) : null}

      <label>
        Member name
        <Input
          type="text"
          autoComplete="off"
          {...register('member_name')}
          data-testid="new-request-name"
        />
      </label>
      {formState.errors.member_name ? (
        <p className="kd-form-error" role="alert">
          {formState.errors.member_name.message}
        </p>
      ) : null}

      <label>
        Reason
        <Input type="text" {...register('reason')} data-testid="new-request-reason" />
      </label>
      {formState.errors.reason ? (
        <p className="kd-form-error" role="alert">
          {formState.errors.reason.message}
        </p>
      ) : null}

      <label>
        Comment
        {watchedUrgent ? (
          <span className="kd-required-marker"> (Required for urgent requests)</span>
        ) : null}
        <Input type="text" {...register('comment')} data-testid="new-request-comment" />
      </label>

      <Collapsible
        open={buildingsOpen}
        onOpenChange={setBuildingsOpen}
        className="kd-buildings-collapsible"
        data-testid="new-request-buildings"
      >
        <CollapsibleTrigger
          className="kd-buildings-trigger"
          data-testid="new-request-buildings-trigger"
        >
          <span data-testid="new-request-buildings-summary">
            <strong>Buildings</strong>{' '}
            {watchedScope === 'stake' ? <small>(at least one required)</small> : null}
            <br />
            <span className="kd-buildings-summary-text">
              {buildingsHeaderLabel(watchedBuildings)}
            </span>
          </span>
        </CollapsibleTrigger>
        <CollapsibleContent>
          {buildings.length === 0 ? (
            <p className="kd-empty-state">
              No buildings configured. Ask a Kindoo Manager to add buildings via Configuration.
            </p>
          ) : (
            <ul className="kd-checkbox-list">
              {buildings.map((b) => {
                const checked = watchedBuildings.includes(b.building_name);
                return (
                  <li key={b.building_id}>
                    <label>
                      <input
                        type="checkbox"
                        value={b.building_name}
                        checked={checked}
                        onChange={(e) => {
                          const current = watchedBuildings;
                          const next = e.target.checked
                            ? [...current, b.building_name]
                            : current.filter((n) => n !== b.building_name);
                          setValue('building_names', next, {
                            shouldValidate: true,
                            shouldDirty: true,
                          });
                        }}
                        data-testid={`new-request-building-${b.building_id}`}
                      />{' '}
                      {b.building_name}
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </CollapsibleContent>
        {formState.errors.building_names ? (
          <p className="kd-form-error" role="alert">
            {formState.errors.building_names.message}
          </p>
        ) : null}
      </Collapsible>

      {dupHit ? (
        <div
          className="kd-duplicate-warning"
          role="status"
          data-testid="new-request-duplicate-warning"
        >
          <Badge variant="warning">Heads up</Badge> {dupHit.member_email} already has a{' '}
          {dupHit.type} seat in {dupHit.scope}. You can still submit if you mean to; the manager
          will see the duplicate too.
        </div>
      ) : null}

      <div className="kd-urgent-block">
        <label className="kd-urgent-row">
          <input type="checkbox" {...register('urgent')} data-testid="new-request-urgent" /> Urgent?
        </label>
        {watchedUrgent ? (
          <p className="kd-urgent-hint" data-testid="new-request-urgent-hint">
            Add a comment explaining the urgency
          </p>
        ) : null}
      </div>

      <div className="form-actions">
        <Button type="submit" disabled={submit.isPending} data-testid="new-request-submit">
          {submit.isPending ? 'Submitting…' : 'Submit request'}
        </Button>
      </div>
    </form>
  );
}
