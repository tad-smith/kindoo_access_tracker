// `NewRequestForm` — the shared add_manual / add_temp form rendered on
// `/bishopric/new` and `/stake/new`. Forks per role solely on which
// scopes are available (single role → implicit scope; multi-role →
// dropdown); every other behaviour is identical between roles.
//
// Field set:
//   - Request type (add_manual / add_temp)
//   - Dates (add_temp only — shown directly under the type selector)
//   - Member email (required)
//   - Member name (required client + server)
//   - Reason (required)
//   - Comment (free-form)
//   - Buildings — collapsible checkbox group whose default selection
//     and collapsed/expanded state are derived from the *current scope*
//     (not from role-at-mount):
//       - scope == 'stake'  → expanded, no defaults checked.
//       - scope == <ward>   → collapsed, that ward's building pre-selected.
//     A multi-role principal toggling the scope dropdown live-updates
//     both the selection and the open state. The user's manual expand
//     / collapse since the last scope change resets on scope change so
//     a stake-scope expansion does not bleed into the ward-scope view.
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
import {
  defaultBuildingsForScope,
  isCrossWardSelection,
  makeNewRequestSchema,
  type NewRequestForm,
} from '../schemas';
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
  /** Wards catalogue. Used to compute the default-selected building(s)
   *  for ward scopes from each ward's `building_name` field. Empty
   *  while loading → defaults fall back to empty and the manager picks
   *  at completion. */
  wards: readonly Ward[];
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Header summary parts. The label portion ("Buildings:") is bolded in
 * the trigger; the value portion (the joined names or "none selected")
 * is rendered at normal weight so building names do not visually
 * compete with the field label. Pluralisation tracks the count.
 */
function buildingsHeaderParts(selected: readonly string[]): {
  label: string;
  value: string;
} {
  if (selected.length === 0) return { label: 'Buildings:', value: 'none selected' };
  const word = selected.length === 1 ? 'Building:' : 'Buildings:';
  return { label: word, value: selected.join(', ') };
}

export function NewRequestForm({ scopes, buildings, wards }: NewRequestFormProps) {
  const submit = useSubmitRequest();
  const initialScope = scopes[0]?.value ?? '';

  // Initial-mount default selection mirrors the scope-change rule
  // below: if the form opens on a ward, pre-select that ward's
  // building; if it opens on `stake`, leave empty.
  const initialBuildings = useMemo(
    () => defaultBuildingsForScope(initialScope, wards),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [], // captured once for `defaultValues`; live updates flow through the scope-driven effect below.
  );

  // Schema closes over the wards catalogue so the cross-ward-comment-
  // required gate can map a ward code to its default building. Memo
  // keys on `wards` so the resolver picks up the rule once the live
  // subscription hydrates.
  const schema = useMemo(() => makeNewRequestSchema(wards), [wards]);

  const form = useForm<NewRequestForm>({
    resolver: zodResolver(schema),
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

  // Two independent triggers force a comment: urgent submissions
  // (existing rule) and ward-scope submissions touching buildings
  // outside the ward's default set (cross-ward justification rule).
  // Either one flips the field label from "(optional)" to "(required)"
  // so the user sees the constraint before they hit submit.
  const crossWard = isCrossWardSelection(watchedScope, watchedBuildings, wards);
  const commentRequired = watchedUrgent || crossWard;

  // Open state mirrors the scope-derived rule on every scope change:
  // stake-scope opens expanded; ward-scope opens collapsed. The user
  // can override mid-edit; the override resets on the next scope flip.
  const [buildingsOpen, setBuildingsOpen] = useState<boolean>(initialScope === 'stake');

  // Drive both the selection and the open state from `watchedScope`.
  // Two separate effects on purpose — the selection effect also
  // depends on `wards` (live subscription late-hydration), while the
  // open-state effect must NOT thrash on every wards push.
  const lastScopeForBuildings = useRef<string>(initialScope);
  useEffect(() => {
    const next = defaultBuildingsForScope(watchedScope, wards);
    setValue('building_names', next, { shouldDirty: false, shouldValidate: false });
    lastScopeForBuildings.current = watchedScope;
  }, [watchedScope, wards, setValue]);

  const lastScopeForOpen = useRef<string>(initialScope);
  useEffect(() => {
    if (lastScopeForOpen.current === watchedScope) return;
    setBuildingsOpen(watchedScope === 'stake');
    lastScopeForOpen.current = watchedScope;
  }, [watchedScope]);

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
      // Reset clears user edits, so re-apply the scope-driven defaults
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
        building_names: defaultBuildingsForScope(input.scope, wards),
        urgent: false,
      });
      setBuildingsOpen(input.scope === 'stake');
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
        <span
          className={commentRequired ? 'kd-required-marker' : 'kd-optional-marker'}
          data-testid="new-request-comment-marker"
        >
          {commentRequired ? ' (required)' : ' (optional)'}
        </span>
        <Input type="text" {...register('comment')} data-testid="new-request-comment" />
      </label>
      {formState.errors.comment ? (
        <p className="kd-form-error" role="alert" data-testid="new-request-comment-error">
          {formState.errors.comment.message}
        </p>
      ) : null}

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
          <span className="kd-buildings-header-row" data-testid="new-request-buildings-summary">
            <strong>{buildingsHeaderParts(watchedBuildings).label}</strong>{' '}
            <span className="kd-buildings-header-values">
              {buildingsHeaderParts(watchedBuildings).value}
            </span>
            {watchedScope === 'stake' ? (
              <small className="kd-buildings-required-marker"> (at least one required)</small>
            ) : null}
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
