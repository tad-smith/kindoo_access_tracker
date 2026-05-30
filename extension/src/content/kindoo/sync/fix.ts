// Sync Phase 2 fix dispatcher (CS-side). One exported entry point per
// fix action; each picks either:
//
//   - the SBA-side path: a `syncApplyFix` callable round-trip via the
//     SW, which stamps the seat write with the `SyncActor:<code>`
//     sentinel server-side, OR
//   - the Kindoo-side path: `syncProvisionFromSeat` from
//     `../sync-provision.ts`, which drives Kindoo to match the SBA seat
//     via the same low-level endpoint helpers the v2.2 provision
//     orchestrator uses.
//
// The split mirrors `extension/docs/sync-design.md` §"Phase 2 — Fix
// actions": SBA-side codes flow through the callable; Kindoo-side
// codes never reach the backend.
//
// Trust-fire: no confirmation dialog, no success toast. The dispatcher
// resolves and the panel splices the row out of its local list. Errors
// surface inline on the row with a Retry button.

import type {
  Building,
  KindooSite,
  Seat,
  Stake,
  SyncApplyFixInput,
  SyncApplyFixResult,
  Ward,
} from '@kindoo/shared';
import type { KindooSession } from '../auth';
import type { KindooEnvironment } from '../endpoints';
import type { Discrepancy } from './detector';
import { syncApplyFix as callSyncApplyFix } from '../../../lib/extensionApi';
import { syncProvisionFromSeat } from '../sync-provision';
import type { ProvisionDeps, ProvisionResult } from '../provision';

/** Result envelope the panel renders. Success → splice the row; error
 * → inline message + Retry button. */
export type FixOutcome = { ok: true } | { ok: false; error: string };

/** Which side a fix click writes to — drives button labels in the
 * panel + tests assert against the branch picked. */
export type FixSide = 'sba' | 'kindoo';

/** One concrete fix action available on a discrepancy row. Codes that
 * surface two buttons (Update Kindoo / Update SBA) emit two `FixAction`s. */
export interface FixAction {
  /** Side of the system this fix writes to. */
  side: FixSide;
  /** Button label (operator-facing). Trust-fire model — be specific. */
  label: string;
  /** Stable test id suffix appended to `sba-sync-fix-` for tests. */
  testId: string;
}

/** Enumerate the fix actions available on a discrepancy row. Order
 * matters — the panel renders them left-to-right in this order. */
export function fixActionsFor(d: Discrepancy): FixAction[] {
  switch (d.code) {
    case 'sba-only':
      return [{ side: 'kindoo', label: 'Provision in Kindoo', testId: 'provision-kindoo' }];
    case 'kindoo-only':
      return [{ side: 'sba', label: 'Create SBA seat', testId: 'create-sba' }];
    case 'extra-kindoo-calling':
      // The `syncApplyFix` extra-kindoo-calling path appends to the
      // seat's roster `callings[]`. That's correct for an AUTO seat. A
      // MANUAL / temp seat records its calling in the single free-text
      // `reason`, not `callings[]`, so a one-click append would mint a
      // hybrid seat (`callings: [X]` + `reason: "Y"`) — wrong shape.
      // For those, surface the drift as review-only (no fix button); the
      // operator reconciles `reason` in the web app. See
      // `extension/docs/sync-design.md` Stage 1 (e) implementation note.
      if (d.sba?.type === 'auto') {
        return [{ side: 'sba', label: 'Add to SBA seat', testId: 'add-callings-sba' }];
      }
      return [];
    case 'type-mismatch':
      // Grant-derived type: Kindoo's observed direct grants are now the
      // source of truth for `type`, so the only sensible action is to
      // flip the SBA seat to match (PROMOTE → auto, DEMOTE → manual).
      // There's no "Update Kindoo" — the extension can't write church
      // grants, and revoke-on-promote is Stage 2.
      return [{ side: 'sba', label: 'Update SBA', testId: 'update-sba' }];
    case 'scope-mismatch':
      return [
        { side: 'kindoo', label: 'Update Kindoo', testId: 'update-kindoo' },
        { side: 'sba', label: 'Update SBA', testId: 'update-sba' },
      ];
    case 'buildings-mismatch':
      return [
        { side: 'kindoo', label: 'Update Kindoo', testId: 'update-kindoo' },
        { side: 'sba', label: 'Update SBA', testId: 'update-sba' },
      ];
    case 'kindoo-unparseable':
      return [];
  }
}

/** Inputs the dispatcher needs to drive every fix. The Kindoo side
 * helpers need stake / wards / buildings / envs / session; the SBA
 * side just needs the row. The panel hands in whatever's loaded. */
export interface DispatchContext {
  /** Active stake the fix targets — used as the callable payload's
   * `stakeId` and threaded into Firestore reads / writes. */
  stakeId: string;
  stake: Stake;
  wards: Ward[];
  buildings: Building[];
  /**
   * T-42: foreign-Kindoo-site directory. The Kindoo-side `Update Kindoo`
   * fix path threads this to `syncProvisionFromSeat` so the per-site
   * `unionSeatBuildings` filter excludes parallel-site duplicates from
   * the active session's write. Without it the orchestrator falls back
   * to the pre-T-42 "union every grant" path and pushes foreign-site
   * buildings into the active Kindoo environment.
   */
  kindooSites: KindooSite[];
  /** Pre-loaded Kindoo environments for `findEnvironment`. v2.2 fetches
   * via `getEnvironments` on demand; sync resolves it once at run time
   * and reuses it across rows. */
  envs: KindooEnvironment[];
  session: KindooSession;
  /** Dependency injection for tests — bypassed in production. */
  deps?: ProvisionDeps;
  /** Override for the SW callable wrapper — tests substitute it; in
   * production the real wrapper is used. */
  callSyncApplyFix?: (input: SyncApplyFixInput) => Promise<SyncApplyFixResult>;
  /** Override for the Kindoo-side provisioner — tests substitute it. */
  syncProvisionFromSeat?: typeof syncProvisionFromSeat;
}

/**
 * Apply one fix action against one discrepancy row. Picks the SBA or
 * Kindoo path by `action.side` and the row's code; returns a flat
 * `FixOutcome` the panel can render.
 *
 * Errors are caught and returned as `{ ok: false, error }` so the
 * panel never has to thread a try/catch through the click handler;
 * unhandled throws would split the rendering state in two.
 */
export async function applyFix(
  d: Discrepancy,
  action: FixAction,
  ctx: DispatchContext,
): Promise<FixOutcome> {
  try {
    if (action.side === 'sba') {
      const result = await dispatchSbaFix(d, ctx);
      if (result.success) return { ok: true };
      return { ok: false, error: result.error };
    }
    // Kindoo side — synth seat from row, drive Kindoo to it.
    await dispatchKindooFix(d, ctx);
    return { ok: true };
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
      // Callings on the new seat = ALL calling names the parser found on
      // the primary segment, independent of the type decision. The
      // classifier's matched (`intendedCallings`) + unmatched
      // (`intendedFreeText`) lists together reconstruct that full list;
      // type no longer gates which callings land on the seat.
      const callings = combineParsedCallings(d.kindoo.intendedCallings, d.kindoo.intendedFreeText);
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
      // Reason is the operator-typed parens free-text; keep it for
      // manual / temp seats (an auto seat's calling drives it). Source
      // from the full primary calling text so a grant-promoted seat
      // doesn't silently drop the reason the classifier had stashed.
      const reason = d.kindoo.intendedFreeText.trim();
      if (reason.length > 0 && createdType !== 'auto') {
        (payload as { reason?: string }).reason = reason;
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
      return {
        stakeId,
        fix: {
          code: 'type-mismatch',
          payload: { memberEmail: d.displayEmail, newType: d.kindoo.grantTargetType },
        },
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
    case 'sba-only':
    case 'kindoo-unparseable':
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

/**
 * Kindoo-side fix paths. Synthesises a `Seat` shape from the row's SBA
 * block when needed (for `sba-only` we use the SBA block as the
 * truth; for `*-mismatch` Update Kindoo we also use SBA as truth) and
 * hands it to `syncProvisionFromSeat`.
 *
 * Only `sba-only`, `scope-mismatch`, and `buildings-mismatch` reach
 * here — `type-mismatch` no longer surfaces a Kindoo-side action
 * (grants own type; the extension can't write church grants), so there
 * is no auto-seat guard to apply.
 */
async function dispatchKindooFix(d: Discrepancy, ctx: DispatchContext): Promise<ProvisionResult> {
  if (!d.sba) {
    throw new Error(`${d.code} has no SBA seat to drive Kindoo from`);
  }
  const provision = ctx.syncProvisionFromSeat ?? syncProvisionFromSeat;
  const seat = synthesizeSeatFromBlocks(d);
  return provision({
    seat,
    stake: ctx.stake,
    wards: ctx.wards,
    buildings: ctx.buildings,
    // T-42: pass the foreign-site directory so `unionSeatBuildings`
    // can resolve the active session's site id and filter the per-site
    // write target. Without this the synthesised seat's duplicate
    // grants (parallel-site) leak into the active environment.
    kindooSites: ctx.kindooSites,
    envs: ctx.envs,
    session: ctx.session,
    ...(ctx.deps !== undefined ? { deps: ctx.deps } : {}),
  });
}

/**
 * Build a `Seat`-shaped object from the discrepancy row's SBA block.
 * The provisioner only reads identity + scope/type/callings/reason/
 * buildings + duplicate_grants — never the bookkeeping fields — so we
 * cast through `unknown` rather than synthesise phantom timestamps.
 */
function synthesizeSeatFromBlocks(d: Discrepancy): Seat {
  if (!d.sba) throw new Error('synthesizeSeatFromBlocks called with no SBA block');
  const partial: Pick<
    Seat,
    | 'member_canonical'
    | 'member_email'
    | 'member_name'
    | 'scope'
    | 'type'
    | 'callings'
    | 'building_names'
    | 'duplicate_grants'
  > & { reason?: string; start_date?: string; end_date?: string } = {
    member_canonical: d.canonical,
    member_email: d.displayEmail,
    member_name: d.kindoo?.memberName ?? d.displayEmail,
    scope: d.sba.scope,
    type: d.sba.type,
    callings: d.sba.callings,
    building_names: d.sba.buildingNames,
    duplicate_grants: [],
  };
  if (d.sba.reason !== undefined) partial.reason = d.sba.reason;
  // The detector's SbaBlock doesn't currently surface start_date /
  // end_date; for sync-driven Kindoo writes on temp seats we fall back
  // to Kindoo's existing dates (the provisioner echoes them when the
  // seat doesn't override).
  return partial as Seat;
}
