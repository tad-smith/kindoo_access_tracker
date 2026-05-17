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
import { STAKE_ID } from '../../../lib/constants';

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
      return [{ side: 'sba', label: 'Add to SBA seat', testId: 'add-callings-sba' }];
    case 'scope-mismatch':
    case 'type-mismatch':
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
  const input = buildCallableInput(d);
  return call(input);
}

/**
 * Build the discriminated `SyncApplyFixInput` for a discrepancy row.
 * Exported for tests that want to assert the wire payload without
 * mocking the dispatcher.
 */
export function buildCallableInput(d: Discrepancy): SyncApplyFixInput {
  switch (d.code) {
    case 'kindoo-only': {
      if (!d.kindoo) throw new Error('kindoo-only row missing Kindoo block');
      const callings =
        d.kindoo.intendedType === 'auto'
          ? d.kindoo.intendedCallings
          : splitFreeText(d.kindoo.intendedFreeText);
      // Auto seats: prefer the door-grant-derived building set when
      // available. The bulk listing's AccessSchedules (the source of
      // `buildingNames`) misses Church Access Automation's direct
      // grants; `derivedBuildings` is the strict-subset chain that
      // covers BOTH grant kinds. Fall back to `buildingNames` if
      // derivation failed (null) so the seat still gets created with
      // whatever building data the sync had — the operator can repair
      // later via Update SBA on a buildings-mismatch row.
      const buildingNames =
        d.kindoo.intendedType === 'auto' &&
        d.kindoo.derivedBuildings !== null &&
        d.kindoo.derivedBuildings !== undefined
          ? d.kindoo.derivedBuildings
          : d.kindoo.buildingNames;
      // intended scope falls back to the parsed primary scope; without
      // either the seat can't be written. Use the raw email canonical as
      // a last-ditch fallback (server validates anyway).
      const scope =
        (d.kindoo.intendedType !== null ? d.kindoo.primaryScope : null) ??
        d.kindoo.primaryScope ??
        'stake';
      const payload: SyncApplyFixInput['fix']['payload'] = {
        memberEmail: d.displayEmail,
        memberName: d.kindoo.memberName,
        scope,
        type: d.kindoo.intendedType ?? 'manual',
        callings,
        buildingNames,
        isTempUser: d.kindoo.isTempUser,
      };
      const reason = d.kindoo.intendedFreeText.trim();
      if (reason.length > 0 && d.kindoo.intendedType !== 'auto') {
        (payload as { reason?: string }).reason = reason;
      }
      if (d.kindoo.intendedType === 'temp') {
        if (d.kindoo.startDate) (payload as { startDate?: string }).startDate = d.kindoo.startDate;
        if (d.kindoo.endDate) (payload as { endDate?: string }).endDate = d.kindoo.endDate;
      }
      return {
        stakeId: STAKE_ID,
        fix: { code: 'kindoo-only', payload: payload as never },
      };
    }
    case 'extra-kindoo-calling': {
      if (!d.kindoo) throw new Error('extra-kindoo-calling row missing Kindoo block');
      return {
        stakeId: STAKE_ID,
        fix: {
          code: 'extra-kindoo-calling',
          payload: {
            memberEmail: d.displayEmail,
            extraCallings: splitFreeText(d.kindoo.intendedFreeText),
          },
        },
      };
    }
    case 'scope-mismatch': {
      if (!d.kindoo || d.kindoo.primaryScope === null) {
        throw new Error('scope-mismatch row missing resolved Kindoo scope');
      }
      return {
        stakeId: STAKE_ID,
        fix: {
          code: 'scope-mismatch',
          payload: { memberEmail: d.displayEmail, newScope: d.kindoo.primaryScope },
        },
      };
    }
    case 'type-mismatch': {
      if (!d.kindoo || d.kindoo.intendedType === null) {
        throw new Error('type-mismatch row missing resolved Kindoo type');
      }
      return {
        stakeId: STAKE_ID,
        fix: {
          code: 'type-mismatch',
          payload: { memberEmail: d.displayEmail, newType: d.kindoo.intendedType },
        },
      };
    }
    case 'buildings-mismatch': {
      if (!d.kindoo) throw new Error('buildings-mismatch row missing Kindoo block');
      // Auto seats: the bulk listing's AccessSchedules-derived
      // `buildingNames` is empty for ~310 of ~313 users because Church
      // Access Automation grants are direct (per-door) not rule-based.
      // `derivedBuildings` (door-grant strict-subset chain) is the
      // truth. Sending `buildingNames` here would wipe the seat's
      // correct buildings server-side (`applyBuildingsMismatch`
      // replaces unconditionally). For manual/temp seats the
      // AccessSchedules-derived `buildingNames` is the truth.
      const isAuto = (d.sba?.type ?? null) === 'auto' || d.kindoo.intendedType === 'auto';
      let newBuildingNames: string[];
      if (isAuto) {
        if (d.kindoo.derivedBuildings === null || d.kindoo.derivedBuildings === undefined) {
          throw new Error(
            'auto seat door-grant derivation failed; cannot update SBA buildings — re-run Sync.',
          );
        }
        newBuildingNames = d.kindoo.derivedBuildings;
      } else {
        newBuildingNames = d.kindoo.buildingNames;
      }
      return {
        stakeId: STAKE_ID,
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
 * Kindoo-side fix paths. Synthesises a `Seat` shape from the row's SBA
 * block when needed (for `sba-only` we use the SBA block as the
 * truth; for `*-mismatch` Update Kindoo we also use SBA as truth) and
 * hands it to `syncProvisionFromSeat`.
 */
async function dispatchKindooFix(d: Discrepancy, ctx: DispatchContext): Promise<ProvisionResult> {
  if (!d.sba) {
    throw new Error(`${d.code} has no SBA seat to drive Kindoo from`);
  }
  if (d.code === 'type-mismatch' && d.sba.type === 'auto') {
    throw new Error(
      'auto seats provisioned by Church Access Automation; not modifiable from the extension.',
    );
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
