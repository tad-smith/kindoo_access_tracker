// Sync Phase 2 fix dispatcher (CS-side). Kindoo is the authoritative
// source: sync never writes SBA → Kindoo. Every fix flows through the
// SBA-side path — a `syncApplyFix` callable round-trip via the SW,
// which stamps the seat write with the `SyncActor:<code>` sentinel
// server-side. Provisioning into Kindoo happens through SBA requests,
// not sync; the only sync action toward an orphaned SBA seat is REMOVE.
//
// Trust-fire: no confirmation dialog, no success toast. The dispatcher
// resolves and the panel splices the row out of its local list. Errors
// surface inline on the row with a Retry button.

import type { SyncApplyFixInput, SyncApplyFixResult } from '@kindoo/shared';
import type { Discrepancy } from './detector';
import { syncApplyFix as callSyncApplyFix } from '../../../lib/extensionApi';

/** Result envelope the panel renders. Success → splice the row; error
 * → inline message + Retry button. */
export type FixOutcome = { ok: true } | { ok: false; error: string };

/** Which side a fix click writes to. Kindoo is authoritative, so every
 * fix now writes to `sba`; the field stays as the button-label / test
 * discriminator the panel + tests assert against. */
export type FixSide = 'sba';

/** One concrete fix action available on a discrepancy row. Codes that
 * surface two buttons (e.g. scope-mismatch Update SBA) emit one
 * `FixAction` each. */
export interface FixAction {
  /** Side of the system this fix writes to. */
  side: FixSide;
  /** Button label (operator-facing). Trust-fire model — be specific. */
  label: string;
  /** Stable test id suffix appended to `sba-sync-fix-` for tests. */
  testId: string;
  /** Visual emphasis. `danger` → red button (destructive removal). */
  variant?: 'danger';
}

/** Enumerate the fix actions available on a discrepancy row. Order
 * matters — the panel renders them left-to-right in this order. */
export function fixActionsFor(d: Discrepancy): FixAction[] {
  // Invariant: a review-severity row is display-only by construction —
  // it never offers an action button, regardless of code. This guards
  // the non-Guest present-but-unparseable case (a Kindoo Manager who
  // also holds an SBA seat is emitted as `kindoo-unparseable` /
  // `review`, FYI only; Update SBA would clobber their seat) and
  // future-proofs the model (review ⇒ no action).
  if (d.severity === 'review') return [];
  switch (d.code) {
    case 'sba-only':
      // Kindoo-authoritative: an SBA seat with no Kindoo presence is an
      // orphan, so the only action is to delete it from SBA. (Was a
      // Kindoo-side "Provision in Kindoo" write before the shift.)
      return [{ side: 'sba', label: 'Remove From SBA', testId: 'remove-sba', variant: 'danger' }];
    case 'kindoo-only':
      return [{ side: 'sba', label: 'Create SBA seat', testId: 'create-sba' }];
    case 'extra-kindoo-calling':
      // Auto seats only by construction (the detector suppresses this
      // code for manual / temp). The `syncApplyFix` path appends to the
      // roster `callings[]`, which is the auto-seat shape. The testId
      // stays `add-callings-sba` (the underlying append path is
      // unchanged); only the user-facing label matches the other
      // Update-SBA buttons.
      return [{ side: 'sba', label: 'Update SBA', testId: 'add-callings-sba' }];
    case 'type-mismatch':
      // Grant-derived type: Kindoo's observed direct grants are the
      // source of truth for `type`, so the only action is to flip the
      // SBA seat to match (PROMOTE → auto, DEMOTE → manual).
      return [{ side: 'sba', label: 'Update SBA', testId: 'update-sba' }];
    case 'scope-mismatch':
      return [{ side: 'sba', label: 'Update SBA', testId: 'update-sba' }];
    case 'buildings-mismatch':
      return [{ side: 'sba', label: 'Update SBA', testId: 'update-sba' }];
    case 'kindoo-unparseable':
      // Present-but-unparseable: treat as a church-wide stake-scope
      // calling. The callable moves the seat to stake scope and sets the
      // calling from the raw description.
      return [{ side: 'sba', label: 'Update SBA', testId: 'update-sba' }];
    case 'kindoo-no-description':
      // Blank description — review-only, no derivable SBA action.
      return [];
  }
}

/** Inputs the dispatcher needs to drive every fix. Kindoo is
 * authoritative, so the dispatcher only needs the target stake + the
 * row; the panel hands in whatever's loaded. */
export interface DispatchContext {
  /** Active stake the fix targets — used as the callable payload's
   * `stakeId` and threaded into Firestore reads / writes. */
  stakeId: string;
  /** Override for the SW callable wrapper — tests substitute it; in
   * production the real wrapper is used. */
  callSyncApplyFix?: (input: SyncApplyFixInput) => Promise<SyncApplyFixResult>;
}

/**
 * Apply one fix action against one discrepancy row. Every fix dispatches
 * through the SBA-side callable; returns a flat `FixOutcome` the panel
 * can render.
 *
 * Errors are caught and returned as `{ ok: false, error }` so the
 * panel never has to thread a try/catch through the click handler;
 * unhandled throws would split the rendering state in two.
 */
export async function applyFix(
  d: Discrepancy,
  _action: FixAction,
  ctx: DispatchContext,
): Promise<FixOutcome> {
  try {
    const result = await dispatchSbaFix(d, ctx);
    if (result.success) return { ok: true };
    return { ok: false, error: result.error };
  } catch (err) {
    return { ok: false, error: describeError(err) };
  }
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * SBA-side fix paths. Constructs the callable payload from the row's
 * detector output (SBA + Kindoo blocks) and dispatches via the SW.
 */
async function dispatchSbaFix(d: Discrepancy, ctx: DispatchContext): Promise<SyncApplyFixResult> {
  const call = ctx.callSyncApplyFix ?? callSyncApplyFix;
  const input = buildCallableInput(ctx.stakeId, d);
  return call(input);
}

/**
 * Build the discriminated `SyncApplyFixInput` for a discrepancy row.
 * Exported for tests that want to assert the wire payload without
 * mocking the dispatcher.
 */
export function buildCallableInput(stakeId: string, d: Discrepancy): SyncApplyFixInput {
  switch (d.code) {
    case 'kindoo-only': {
      if (!d.kindoo) throw new Error('kindoo-only row missing Kindoo block');
      // Grant-derived seat type. The detector carries the church-backed
      // decision via `grantTargetType` (temp → temp, church-backed →
      // auto, else manual). Fall back to manual when absent — born-manual
      // is the safe default. Classifier `intendedType` is no longer the
      // source of the created type (it's template-derived and drifts).
      const createdType = d.kindoo.grantTargetType ?? 'manual';
      // The full parsed calling list = classifier matched
      // (`intendedCallings`) + unmatched (`intendedFreeText`), de-duped.
      // Where it lands on the new seat depends on the type, matching how
      // the request flow + `markRequestComplete` shape seats
      // (`docs/spec.md` §13):
      //   - auto  → roster `callings[]` (no `reason`).
      //   - manual / temp → `callings: []`; the calling text lives in the
      //     single free-text `reason`. Writing it to `callings[]` would
      //     mint a hybrid seat that re-fires `extra-kindoo-calling` on the
      //     next sync (the manual diff reads `reason`, not `callings[]`).
      const parsedCallings = combineParsedCallings(
        d.kindoo.intendedCallings,
        d.kindoo.intendedFreeText,
      );
      const callings = createdType === 'auto' ? parsedCallings : [];
      // Prefer the door-grant-derived building set for ALL seat types
      // when available. The bulk listing's AccessSchedules (the source of
      // `buildingNames`) misses Church Access Automation's direct grants;
      // `derivedBuildings` is the strict-subset chain that covers BOTH
      // direct and rule-based grants, so it is the authoritative Kindoo
      // door-access signal. Fall back to `buildingNames` only when
      // derivation failed (null/undefined) so the seat still gets created
      // with whatever building data the sync had — unlike the
      // buildings-mismatch fix (which refuses when derivedBuildings is
      // null), creating a fresh seat with partial building data is
      // acceptable here, and the operator can repair later via Update SBA.
      const buildingNames =
        d.kindoo.derivedBuildings !== null && d.kindoo.derivedBuildings !== undefined
          ? d.kindoo.derivedBuildings
          : d.kindoo.buildingNames;
      // Scope falls back to the parsed primary scope; without either the
      // seat can't be written. Use stake as a last-ditch fallback (server
      // validates anyway).
      const scope = d.kindoo.primaryScope ?? 'stake';
      const payload: SyncApplyFixInput['fix']['payload'] = {
        memberEmail: d.displayEmail,
        memberName: d.kindoo.memberName,
        scope,
        type: createdType,
        callings,
        buildingNames,
        isTempUser: d.kindoo.isTempUser,
      };
      // Manual / temp seats record their calling text in `reason` — the
      // FULL parsed calling list (not just `intendedFreeText`, which is
      // only the classifier's unmatched remainder and would be empty when
      // the classifier matched everything, leaving the calling recorded
      // nowhere). Auto seats carry the calling in `callings[]` instead.
      if (createdType !== 'auto') {
        const reason = parsedCallings.join(', ').trim();
        if (reason.length > 0) (payload as { reason?: string }).reason = reason;
      }
      if (createdType === 'temp') {
        if (d.kindoo.startDate) (payload as { startDate?: string }).startDate = d.kindoo.startDate;
        if (d.kindoo.endDate) (payload as { endDate?: string }).endDate = d.kindoo.endDate;
      }
      return {
        stakeId,
        fix: { code: 'kindoo-only', payload: payload as never },
      };
    }
    case 'extra-kindoo-calling': {
      if (!d.kindoo) throw new Error('extra-kindoo-calling row missing Kindoo block');
      // Source the extras from the detector's callings-set diff
      // (`extraKindooCallings`), NOT the retired auto-calling
      // classifier's `intendedFreeText`. The diff is the set of
      // Kindoo-named callings the SBA seat lacks.
      const extraCallings = d.kindoo.extraKindooCallings ?? [];
      return {
        stakeId,
        fix: {
          code: 'extra-kindoo-calling',
          payload: {
            memberEmail: d.displayEmail,
            extraCallings,
          },
        },
      };
    }
    case 'scope-mismatch': {
      if (!d.kindoo || d.kindoo.primaryScope === null) {
        throw new Error('scope-mismatch row missing resolved Kindoo scope');
      }
      return {
        stakeId,
        fix: {
          code: 'scope-mismatch',
          payload: { memberEmail: d.displayEmail, newScope: d.kindoo.primaryScope },
        },
      };
    }
    case 'type-mismatch': {
      // Grant-based promote / demote. The target type is the
      // observed-provenance decision the detector carries via
      // `grantTargetType` (PROMOTE → auto, DEMOTE → manual), NOT the
      // template-derived `intendedType` (no longer authoritative).
      if (!d.kindoo || d.kindoo.grantTargetType === undefined) {
        throw new Error('type-mismatch row missing grant-derived target type');
      }
      const payload: SyncApplyFixInput['fix']['payload'] = {
        memberEmail: d.displayEmail,
        newType: d.kindoo.grantTargetType,
      };
      // PROMOTE (manual/temp → auto): send the Kindoo-parsed calling(s)
      // (matched ∪ unmatched = the full parsed primary-segment list) so
      // the backend sets the promoted auto seat's `callings[]` from them
      // and clears `reason`. DEMOTE (→ manual) omits `callings`; the
      // backend derives `reason` from the seat's existing callings.
      if (d.kindoo.grantTargetType === 'auto') {
        const callings = combineParsedCallings(
          d.kindoo.intendedCallings,
          d.kindoo.intendedFreeText,
        );
        if (callings.length > 0) (payload as { callings?: string[] }).callings = callings;
      }
      return {
        stakeId,
        fix: { code: 'type-mismatch', payload: payload as never },
      };
    }
    case 'buildings-mismatch': {
      if (!d.kindoo) throw new Error('buildings-mismatch row missing Kindoo block');
      // `derivedBuildings` (the door-grant strict-subset chain) is the
      // authoritative Kindoo door-access truth for ALL seat types — it
      // sees both Church Access Automation direct grants and rule-based
      // grants. The bulk listing's AccessSchedules-derived `buildingNames`
      // misses direct grants (empty for ~310 of ~313 users), so it must
      // never be the source: `applyBuildingsMismatch` replaces
      // unconditionally, and an empty list would wipe a seat that truly
      // has access. When derivation failed, refuse rather than wipe.
      if (d.kindoo.derivedBuildings === null || d.kindoo.derivedBuildings === undefined) {
        throw new Error('door-grant derivation failed; cannot update SBA buildings — re-run Sync.');
      }
      const newBuildingNames = d.kindoo.derivedBuildings;
      return {
        stakeId,
        fix: {
          code: 'buildings-mismatch',
          payload: {
            memberEmail: d.displayEmail,
            newBuildingNames,
          },
        },
      };
    }
    case 'sba-only': {
      // Kindoo-authoritative remove. The kindoo block is null on these
      // rows, so `displayEmail` is the SBA seat's typed email; the
      // backend canonicalizes it to locate the orphaned seat.
      return {
        stakeId,
        fix: { code: 'sba-only', payload: { memberEmail: d.displayEmail } },
      };
    }
    case 'kindoo-unparseable': {
      if (!d.kindoo) throw new Error('kindoo-unparseable row missing Kindoo block');
      // Present-but-unparseable description → church-wide stake-scope
      // calling. The callable sets the seat to `scope='stake'` and writes
      // the calling text from the raw Kindoo description (auto →
      // `callings[]`, manual/temp → `reason`). The raw description is the
      // agreed source. Guard against an empty/whitespace value — the
      // callable rejects an empty `calling`; this shouldn't happen for a
      // present-but-unparseable row (segments exist only when there's text)
      // but fail loud rather than send a payload the server will reject.
      const calling = d.kindoo.description.trim();
      if (calling.length === 0) {
        throw new Error('kindoo-unparseable row has an empty Kindoo description');
      }
      return {
        stakeId,
        fix: {
          code: 'kindoo-unparseable',
          payload: { memberEmail: d.displayEmail, calling },
        },
      };
    }
    case 'kindoo-no-description':
      // Review-only: a blank description has no SBA-side callable path and
      // surfaces no action button, so this is never dispatched. Reaching
      // here means a caller bypassed `fixActionsFor` — fail loud.
      throw new Error(`${d.code} has no SBA-side callable path`);
  }
}

/** Comma-split a free-text payload, trimming + dropping empties. */
function splitFreeText(s: string): string[] {
  return s
    .split(/,\s*/)
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
}

/**
 * Reconstruct the full primary-segment calling list from the
 * classifier's matched (`intendedCallings`) + unmatched
 * (`intendedFreeText`) outputs, de-duped case-insensitively. Together
 * they cover every calling the parser found; type no longer gates which
 * land on the created seat, so the kindoo-only fix sends them all.
 */
function combineParsedCallings(intendedCallings: string[], intendedFreeText: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const c of [...intendedCallings, ...splitFreeText(intendedFreeText)]) {
    const key = c.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}
