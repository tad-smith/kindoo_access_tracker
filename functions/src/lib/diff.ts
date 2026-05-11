// Pure diff-planner for the importer. Takes the parsed sheet rows + the
// current Firestore state, produces a list of writes. No Firestore I/O,
// no clock — `Importer.ts` consumes the plan and applies it.
//
// Shape:
//
//   - One Seat doc per (canonical_email) per stake. Multi-calling people
//     collapse to one doc with `callings[]`.
//   - Access: `importer_callings[scope]` map is wholesale-replaced per
//     scope per run. `manual_grants` is left alone.
//   - Priority: `stake > ward (alphabetical)` for primary scope on Seat;
//     cross-scope auto findings go to `duplicate_grants[]`.
//   - Promotion-on-empty-callings: if primary auto callings → empty AND
//     a manual/temp duplicate exists, promote it to primary.

import { canonicalEmail } from '@kindoo/shared';
import type { Access, Seat } from '@kindoo/shared';
import { matchTemplate, type ParsedRow, type TemplateIndex } from './parser.js';

export type CurrentState = {
  /** All access docs in the stake, keyed by canonical email. */
  accessByCanonical: Map<string, Access>;
  /** All seat docs in the stake, keyed by canonical email. */
  seatsByCanonical: Map<string, Seat>;
};

export type AccessUpsert = {
  canonical: string;
  /** Typed email — derived from the parsed rows (first wins). */
  member_email: string;
  member_name: string;
  /** Final desired `importer_callings` map after the run. */
  importer_callings: Record<string, string[]>;
  /**
   * MIN sheet_order across every calling in `importer_callings` (across
   * all scopes). `null` when `importer_callings` is empty.
   */
  sort_order: number | null;
};

export type AccessDelete = {
  canonical: string;
};

/** A seat write — either create-or-replace (auto), or update of an existing
 *  manual/temp seat's `duplicate_grants[]` to record a cross-grant collision. */
export type SeatWrite =
  | { kind: 'auto-upsert'; seat: SeatAutoNew }
  | { kind: 'auto-delete'; canonical: string }
  | { kind: 'duplicates-update'; canonical: string; duplicate_grants: Seat['duplicate_grants'] };

export type SeatAutoNew = {
  member_canonical: string;
  member_email: string;
  member_name: string;
  scope: string;
  type: 'auto';
  callings: string[];
  building_names: string[];
  duplicate_grants: Seat['duplicate_grants'];
  /**
   * MIN sheet_order across `callings[]` for this seat. `null` when no
   * calling matches a template (orphaned auto seat).
   */
  sort_order: number | null;
};

export type DiffPlan = {
  /** Access docs to set/merge (full importer_callings replacement). */
  accessUpserts: AccessUpsert[];
  /** Access docs to delete (no importer rows AND no manual grants). */
  accessDeletes: AccessDelete[];
  /** Seat writes. */
  seatWrites: SeatWrite[];
  /** Per-tab warnings collected during parsing/diff. */
  warnings: string[];
};

export type ScopeMeta = {
  /** Map ward_code → default building names. */
  wardBuildings: Map<string, string[]>;
  /** All buildings in the stake — defaults for stake-scope auto seats. */
  stakeBuildings: string[];
  /** Set of recognised ward_codes in stake. */
  wardCodes: ReadonlySet<string>;
  /**
   * Template indexes by scope, used to resolve `sheet_order` for any
   * calling-name (including preserved-scope callings whose tab wasn't
   * processed this run). `'stake'` → stake templates; ward_code → ward
   * templates. A missing scope or no template match → `null` for
   * sort_order (orphaned calling).
   */
  templateIndexByScope: Map<string, TemplateIndex>;
};

/**
 * Compute the diff plan from parsed rows + current state. Caller passes
 * only `scopesSeen` — scopes whose tabs were actually processed. Scopes
 * NOT in this set keep their existing importer_callings (per spec §8 I-2:
 * a missing tab leaves prior auto-seats untouched).
 */
export function planDiff(opts: {
  parsedRows: ParsedRow[];
  scopesSeen: Set<string>;
  current: CurrentState;
  scopeMeta: ScopeMeta;
}): DiffPlan {
  const { parsedRows, scopesSeen, current, scopeMeta } = opts;
  const warnings: string[] = [];

  // Group parsed rows by canonical email. One Seat per canonical, with
  // potentially multiple `(scope, calling)` pairs. `sheetOrderByCalling`
  // captures the MIN sheet_order seen for each (scope,calling) so the
  // applier can compute MIN-across-callings for sort_order on the seat
  // and access docs.
  type RowGroup = {
    canonical: string;
    typedEmail: string;
    name: string;
    /** Map scope → list of callings under that scope. */
    callingsByScope: Map<string, string[]>;
    /** Whether ANY parsed row for this canonical had give_app_access=true. */
    accessByScope: Map<string, string[]>;
    /** Map "scope:calling" → MIN sheet_order across rows. */
    sheetOrderByCalling: Map<string, number>;
  };

  const groups = new Map<string, RowGroup>();
  for (const row of parsedRows) {
    const canonical = canonicalEmail(row.email);
    if (!canonical) continue;
    let g = groups.get(canonical);
    if (!g) {
      g = {
        canonical,
        typedEmail: row.email,
        name: row.name,
        callingsByScope: new Map(),
        accessByScope: new Map(),
        sheetOrderByCalling: new Map(),
      };
      groups.set(canonical, g);
    } else {
      // First non-empty name wins; preserve typed email from first row.
      if (!g.name && row.name) g.name = row.name;
    }
    if (row.autoKindooAccess) {
      const seatList = g.callingsByScope.get(row.scope) ?? [];
      if (!seatList.includes(row.calling)) seatList.push(row.calling);
      g.callingsByScope.set(row.scope, seatList);
    }
    if (row.giveAppAccess) {
      const accessList = g.accessByScope.get(row.scope) ?? [];
      if (!accessList.includes(row.calling)) accessList.push(row.calling);
      g.accessByScope.set(row.scope, accessList);
    }
    const key = `${row.scope}:${row.calling}`;
    const prior = g.sheetOrderByCalling.get(key);
    if (prior === undefined || row.sheetOrder < prior) {
      g.sheetOrderByCalling.set(key, row.sheetOrder);
    }
  }

  // ----- Access diff -----
  const accessUpserts: AccessUpsert[] = [];
  const accessDeletes: AccessDelete[] = [];

  // Build the desired importer_callings per canonical, scoping replacement
  // to scopesSeen — for any scope not seen this run, preserve the current
  // doc's importer_callings[scope]. (sort_order is recomputed below
  // alongside finalImporter so preserved-scope callings contribute.)
  const desiredAccessByCanonical = new Map<string, AccessUpsert>();
  for (const [canonical, g] of groups) {
    const desired: Record<string, string[]> = {};
    for (const [scope, callings] of g.accessByScope) {
      if (callings.length > 0) desired[scope] = [...callings].sort();
    }
    desiredAccessByCanonical.set(canonical, {
      canonical,
      member_email: g.typedEmail,
      member_name: g.name,
      importer_callings: desired,
      sort_order: null,
    });
  }

  const allAccessCanonicals = new Set<string>([
    ...current.accessByCanonical.keys(),
    ...desiredAccessByCanonical.keys(),
  ]);
  for (const canonical of allAccessCanonicals) {
    const cur = current.accessByCanonical.get(canonical);
    const desired = desiredAccessByCanonical.get(canonical);

    // Compute final importer_callings: for scopesSeen, use desired's
    // values (or absent → empty). For scopes NOT seen, preserve current's
    // values (per I-2).
    const finalImporter: Record<string, string[]> = {};
    const allScopes = new Set<string>([
      ...Object.keys(cur?.importer_callings ?? {}),
      ...Object.keys(desired?.importer_callings ?? {}),
    ]);
    for (const scope of allScopes) {
      const inDesired = desired?.importer_callings[scope];
      if (scopesSeen.has(scope)) {
        if (inDesired && inDesired.length > 0) finalImporter[scope] = inDesired;
        // else: scope WAS processed; user no longer matches → drop the entry.
      } else {
        const fromCur = cur?.importer_callings[scope];
        if (fromCur && fromCur.length > 0) finalImporter[scope] = [...fromCur];
      }
    }

    const hasManual =
      cur && Object.values(cur.manual_grants ?? {}).some((arr) => arr && arr.length > 0);

    const finalImporterEmpty = Object.keys(finalImporter).length === 0;

    if (finalImporterEmpty && !hasManual) {
      if (cur) accessDeletes.push({ canonical });
      continue;
    }

    accessUpserts.push({
      canonical,
      member_email: desired?.member_email ?? cur?.member_email ?? canonical,
      member_name: desired?.member_name ?? cur?.member_name ?? '',
      importer_callings: finalImporter,
      sort_order: finalImporterEmpty
        ? null
        : minSheetOrderAcrossImporter(finalImporter, scopeMeta.templateIndexByScope),
    });
  }

  // ----- Seat diff -----
  const seatWrites: SeatWrite[] = [];

  // Desired auto seats: for each canonical with parsed callings, pick a
  // primary scope by priority (stake > ward, alphabetical among wards),
  // restricted to scopes the importer ACTUALLY processed this run.
  const desiredAutoSeats = new Map<string, SeatAutoNew>();
  for (const [canonical, g] of groups) {
    const seenScopes = [...g.callingsByScope.keys()].filter((s) => scopesSeen.has(s));
    if (seenScopes.length === 0) continue;
    const primaryScope = pickPrimaryScope(seenScopes);
    const primaryCallings = [...(g.callingsByScope.get(primaryScope) ?? [])].sort();
    const dupGrants: Seat['duplicate_grants'] = [];
    for (const sc of seenScopes) {
      if (sc === primaryScope) continue;
      const callings = [...(g.callingsByScope.get(sc) ?? [])].sort();
      if (callings.length > 0) {
        dupGrants.push({
          scope: sc,
          type: 'auto',
          callings,
          // detected_at is stamped by the applier (FieldValue.serverTimestamp).
          detected_at: null as unknown as Seat['duplicate_grants'][0]['detected_at'],
        });
      }
    }
    desiredAutoSeats.set(canonical, {
      member_canonical: canonical,
      member_email: g.typedEmail,
      member_name: g.name,
      scope: primaryScope,
      type: 'auto',
      callings: primaryCallings,
      building_names: defaultBuildings(primaryScope, scopeMeta),
      duplicate_grants: dupGrants,
      sort_order: minSheetOrderForCallings(
        primaryScope,
        primaryCallings,
        scopeMeta.templateIndexByScope,
      ),
    });
  }

  // For each canonical that currently has an auto seat in scopesSeen, or
  // that we want to make auto, decide write/delete.
  const allSeatCanonicals = new Set<string>([
    ...current.seatsByCanonical.keys(),
    ...desiredAutoSeats.keys(),
  ]);
  for (const canonical of allSeatCanonicals) {
    const cur = current.seatsByCanonical.get(canonical);
    const desiredAuto = desiredAutoSeats.get(canonical);

    if (!cur && desiredAuto) {
      // Brand new auto seat — straightforward upsert.
      seatWrites.push({ kind: 'auto-upsert', seat: desiredAuto });
      continue;
    }

    if (cur && cur.type === 'auto') {
      // Importer-owned. If desired is gone → delete (per I-2 only when
      // the scope was seen, which is guaranteed because we only added
      // current auto seats whose scope is in scopesSeen below).
      if (!desiredAuto) {
        if (scopesSeen.has(cur.scope)) {
          // Promotion-on-empty-callings: if there's a manual/temp
          // duplicate sitting in the prior duplicate_grants, callers
          // can't promote it — auto seats only carry auto duplicates,
          // since manual/temp seats live in their own docs (collisions
          // would surface on those docs' duplicate_grants instead). So
          // a plain delete here is correct.
          seatWrites.push({ kind: 'auto-delete', canonical });
        }
        continue;
      }
      // Compare meaningful fields to decide whether to upsert.
      if (autoSeatChanged(cur, desiredAuto)) {
        seatWrites.push({ kind: 'auto-upsert', seat: desiredAuto });
      }
      continue;
    }

    if (cur && cur.type !== 'auto' && desiredAuto) {
      // Manager-driven manual/temp seat already exists. Importer can't
      // overwrite the primary; record the auto findings as a duplicate
      // grant on the existing seat. The primary calling field stays as
      // is; only `duplicate_grants[]` is updated.
      const newDupes: Seat['duplicate_grants'] = [
        // Preserve existing non-auto duplicates.
        ...(cur.duplicate_grants ?? []).filter((d) => d.type !== 'auto'),
        // Add an auto duplicate per scope from desired (the auto findings).
        {
          scope: desiredAuto.scope,
          type: 'auto',
          callings: desiredAuto.callings,
          detected_at: null as unknown as Seat['duplicate_grants'][0]['detected_at'],
        },
        ...desiredAuto.duplicate_grants,
      ];
      // Compare against existing duplicate_grants (excluding auto-mark
      // server timestamps); if changed, write.
      if (duplicateGrantsChanged(cur.duplicate_grants ?? [], newDupes)) {
        seatWrites.push({
          kind: 'duplicates-update',
          canonical,
          duplicate_grants: newDupes,
        });
      }
      continue;
    }

    // Otherwise: cur exists, !desiredAuto, cur.type !== 'auto'. Importer
    // doesn't touch manual/temp seats; clear any auto-marked duplicates
    // since the auto findings are gone.
    if (cur && cur.type !== 'auto' && !desiredAuto) {
      const filtered = (cur.duplicate_grants ?? []).filter((d) => d.type !== 'auto');
      if (duplicateGrantsChanged(cur.duplicate_grants ?? [], filtered)) {
        seatWrites.push({
          kind: 'duplicates-update',
          canonical,
          duplicate_grants: filtered,
        });
      }
    }
  }

  return { accessUpserts, accessDeletes, seatWrites, warnings };
}

/** Default `building_names` for an auto seat under a scope. */
function defaultBuildings(scope: string, meta: ScopeMeta): string[] {
  if (scope === 'stake') return [...meta.stakeBuildings];
  return [...(meta.wardBuildings.get(scope) ?? [])];
}

/** stake > ward; among wards, alphabetical ascending. */
export function pickPrimaryScope(scopes: string[]): string {
  if (scopes.includes('stake')) return 'stake';
  return [...scopes].sort()[0]!;
}

function autoSeatChanged(cur: Seat, desired: SeatAutoNew): boolean {
  if (cur.scope !== desired.scope) return true;
  if (cur.member_email !== desired.member_email) return true;
  if (cur.member_name !== desired.member_name) return true;
  if (!arrEq(cur.callings, desired.callings)) return true;
  if (!arrEq(cur.building_names, desired.building_names)) return true;
  if (duplicateGrantsChanged(cur.duplicate_grants ?? [], desired.duplicate_grants)) return true;
  if ((cur.sort_order ?? null) !== (desired.sort_order ?? null)) return true;
  return false;
}

/** MIN sheet_order across `callings[]` under one scope. `null` when no calling resolves. */
function minSheetOrderForCallings(
  scope: string,
  callings: string[],
  templates: Map<string, TemplateIndex>,
): number | null {
  const idx = templates.get(scope);
  if (!idx) return null;
  let min: number | null = null;
  for (const c of callings) {
    const tpl = matchTemplate(idx, c);
    if (!tpl) continue;
    const order = typeof tpl.sheet_order === 'number' ? tpl.sheet_order : 0;
    if (min === null || order < min) min = order;
  }
  return min;
}

/** MIN sheet_order across every (scope, calling) pair in `importer_callings`. */
function minSheetOrderAcrossImporter(
  importerCallings: Record<string, string[]>,
  templates: Map<string, TemplateIndex>,
): number | null {
  let min: number | null = null;
  for (const [scope, callings] of Object.entries(importerCallings)) {
    const m = minSheetOrderForCallings(scope, callings, templates);
    if (m !== null && (min === null || m < min)) min = m;
  }
  return min;
}

function arrEq(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function duplicateGrantsChanged(a: Seat['duplicate_grants'], b: Seat['duplicate_grants']): boolean {
  if (a.length !== b.length) return true;
  // Compare by structural shape excluding `detected_at` (server timestamps).
  const norm = (g: Seat['duplicate_grants'][0]) =>
    JSON.stringify({
      scope: g.scope,
      type: g.type,
      callings: g.callings ?? [],
      reason: g.reason ?? '',
      start_date: g.start_date ?? '',
      end_date: g.end_date ?? '',
    });
  const aSet = new Set(a.map(norm));
  const bSet = new Set(b.map(norm));
  if (aSet.size !== bSet.size) return true;
  for (const v of aSet) if (!bSet.has(v)) return true;
  return false;
}
