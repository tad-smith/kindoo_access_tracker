// Discrepancy detector. Compares the union of (SBA seat emails) ∪
// (Kindoo user emails) and emits one row per divergence per the rules
// in `extension/docs/sync-design.md` §"Discrepancy detector".
//
// Pure function. Inputs come from the SW reader (SBA side) + the
// content-script's paginated Kindoo loop. Outputs are rendered by
// `SyncPanel.tsx`.

import { canonicalEmail } from '@kindoo/shared';
import type {
  Building,
  DuplicateGrant,
  Seat,
  SeatType,
  Stake,
  StakeCallingTemplate,
  Ward,
  WardCallingTemplate,
} from '@kindoo/shared';
import type { KindooEnvironmentUser } from '../endpoints';
import {
  parseDescription,
  pickPrimarySegment,
  type ParsedDescription,
  type ParsedSegment,
} from './parser';
import {
  buildCallingTemplateSets,
  classifySegment,
  type CallingTemplateSets,
  type IntendedSeatShape,
} from './classifier';
import type { ActiveSite } from './activeSite';

export type DiscrepancyCode =
  | 'sba-only'
  | 'kindoo-only'
  | 'kindoo-unparseable'
  | 'kindoo-no-description'
  | 'scope-mismatch'
  | 'type-mismatch'
  | 'buildings-mismatch'
  | 'callings-mismatch';

export type Severity = 'drift' | 'review';

/** One row of the report. */
export interface Discrepancy {
  /** Canonical email (used as the row key). */
  canonical: string;
  /** Display email — prefers the Kindoo `Username` typed form, falls
   * back to the SBA seat's `member_email`. */
  displayEmail: string;
  code: DiscrepancyCode;
  severity: Severity;
  /** Plain-English reason rendered under the row. */
  reason: string;
  /** SBA side block — `null` when the user only exists in Kindoo. */
  sba: SbaBlock | null;
  /** Kindoo side block — `null` when the user only exists in SBA. */
  kindoo: KindooBlock | null;
}

export interface SbaBlock {
  scope: string;
  type: Seat['type'];
  callings: string[];
  reason?: string | undefined;
  buildingNames: string[];
}

export interface KindooBlock {
  description: string;
  isTempUser: boolean;
  /** Member display name (`FirstName LastName`) — derived from Kindoo's
   * `FirstName` / `LastName` (or `Username` if neither resolves). The
   * Phase 2 fix dispatcher needs this to populate `memberName` on
   * `kindoo-only` callable payloads (SBA seat schema requires it). */
  memberName: string;
  /** Parsed primary segment's scope (`'stake'` / ward_code / `null`). */
  primaryScope: 'stake' | string | null;
  /** Intended seat shape derived by the classifier from the primary segment. */
  intendedType: IntendedSeatShape['type'] | null;
  /** Auto-matched callings on the primary segment. Empty for manual/temp/unresolved. */
  intendedCallings: string[];
  /** Free-text reason carried by the primary segment (manual/temp parens,
   * or the unmatched-callings remainder on a mixed-auto segment). */
  intendedFreeText: string;
  /** Rule IDs Kindoo currently assigns. */
  ruleIds: number[];
  /** Building names mapped from `ruleIds` via the v2.1 config. */
  buildingNames: string[];
  /**
   * Buildings derived from per-door grants (auto-user reconciliation).
   * `null` when derivation was skipped or failed for this user;
   * `string[]` (possibly empty) when the door-grant chain produced a
   * deterministic set. The detector uses this for auto seats'
   * `buildings-mismatch` comparison; `applyKindooOnly` uses it as the
   * truth when creating an SBA seat from a kindoo-only auto user.
   */
  derivedBuildings: string[] | null;
  /**
   * Buildings the user holds via doors granted by the Church Access
   * Automation **only** (`GrantedBy` = `sentry@groups.churchofjesuschrist.org`
   * or `IsSuperApi`, NOT an `AccessScheduleID` value — real church
   * grants carry `AccessScheduleID: -1`). Drives the grant-based
   * seat-type (church-backed) decision. `null` when door-grant
   * derivation was skipped or failed — promote / demote is skipped.
   */
  directGrantBuildings: string[] | null;
  /**
   * Grant-derived seat type. Set on:
   *   - `type-mismatch` rows — the promote/demote target (PROMOTE →
   *     `'auto'`, DEMOTE → `'manual'`); the fix dispatcher sends it as
   *     the callable's `newType`.
   *   - `kindoo-only` rows — the type the created seat should be born
   *     as (temp → `'temp'`, grant-backed → `'auto'`, else `'manual'`).
   * Undefined on every other code. Always preferred over the
   * template-derived `intendedType`, which is no longer authoritative
   * for type.
   */
  grantTargetType?: SeatType;
  /**
   * The FULL set of calling(s) Kindoo's parsed primary segment names
   * (comma-split, trimmed, de-duped, Kindoo's casing preserved). Set
   * ONLY on `callings-mismatch` rows; undefined elsewhere. The fix
   * dispatcher sends THIS as the callable's `callings` — the target set
   * that REPLACES the seat's prior `callings[]` (Kindoo authoritative),
   * not a delta. Sourced from the parser, not the retired auto-calling
   * classifier.
   */
  kindooCallings?: string[];
  /** ISO date `YYYY-MM-DD` derived from Kindoo's `startAccessDoorsDateAtTimeZone`. Only set when the user is temp. */
  startDate?: string;
  /** ISO date `YYYY-MM-DD` derived from Kindoo's `expiryDateAtTimeZone`. Only set when the user is temp. */
  endDate?: string;
}

export interface DetectInputs {
  stake: Stake;
  wards: Ward[];
  buildings: Building[];
  seats: Seat[];
  wardCallingTemplates: WardCallingTemplate[];
  stakeCallingTemplates: StakeCallingTemplate[];
  /** Every Kindoo environment-user (paginated list flattened). */
  kindooUsers: KindooEnvironmentUser[];
  /**
   * Which Kindoo site the operator's active session is pointed at —
   * resolved by `identifyActiveSite()` from the live EID + SBA config.
   * Scopes the diff to seats / users belonging to that site:
   *   - `home`            → only wards / seats with `kindoo_site_id`
   *                         null / absent (and stake-scope seats).
   *   - `foreign(siteId)` → only wards / seats whose
   *                         `kindoo_site_id === siteId`. Stake-scope
   *                         seats are home-only (Phase 1 policy), so
   *                         they're excluded.
   *   - `unknown`         → caller is responsible for the empty-state
   *                         UX; we still return an empty diff defensively.
   *
   * Optional for backwards compatibility (tests that pre-date Phase 4
   * may not pass one); absence is treated as "no filtering".
   */
  activeSite?: ActiveSite;
}

export interface DetectResult {
  discrepancies: Discrepancy[];
  /** Total SBA seat count — surfaces in the report header. */
  seatCount: number;
  /** Total Kindoo user count — surfaces in the report header. */
  kindooCount: number;
}

/** Build a Map keyed by canonical email for quick lookup. */
function indexSeats(seats: Seat[]): Map<string, Seat> {
  const m = new Map<string, Seat>();
  for (const s of seats) m.set(s.member_canonical, s);
  return m;
}

function indexKindooUsers(users: KindooEnvironmentUser[]): Map<string, KindooEnvironmentUser> {
  const m = new Map<string, KindooEnvironmentUser>();
  for (const u of users) {
    const canon = canonicalEmail(u.username);
    // First-write-wins if Kindoo returns two records for the same canonical
    // email (shouldn't happen, but be defensive).
    if (!m.has(canon)) m.set(canon, u);
  }
  return m;
}

/**
 * Build the SBA side block for a seat. Trivial mapping; lives in its
 * own helper so the detector branches stay readable.
 */
function toSbaBlock(seat: Seat): SbaBlock {
  return {
    scope: seat.scope,
    type: seat.type,
    callings: seat.callings ?? [],
    reason: seat.reason,
    buildingNames: seat.building_names ?? [],
  };
}

/**
 * T-42: a seat's "view" onto one Kindoo site. The detector compares
 * Kindoo's per-site state against this projection, not against the
 * seat's primary fields directly — a seat whose primary lives on
 * another site can still own a grant on the active site through a
 * `duplicate_grants[]` entry.
 *
 * Source of truth resolution:
 *   - The seat's primary contributes when its `kindoo_site_id`
 *     matches the active site.
 *   - Every `duplicate_grants[]` entry whose `kindoo_site_id` matches
 *     contributes too.
 *   - Across contributing grants, the `scope` is taken from the
 *     first contributor (primary if it's there, else the first
 *     same-site duplicate by stable order). `type` comes from the
 *     same. `building_names` is the union across all contributors.
 *   - `callings` carries the per-scope callings of the first
 *     contributor (today's behaviour; segment fan-out at the Kindoo
 *     side classifies one calling list, so the SBA side mirrors).
 *
 * Returns `null` when no grant on the seat targets the active site —
 * the detector treats that as "this seat doesn't exist on this site"
 * and the seat won't surface in either an sba-only or a mismatch row
 * for this view.
 */
function projectSeatForSite(
  seat: Seat,
  wards: Ward[],
  activeSite: ActiveSite | undefined,
): SbaBlock | null {
  if (!activeSite || activeSite.kind === 'unknown') return null;
  const wardSite = (wardCode: string): string | null => {
    if (wardCode === 'stake') return null;
    const ward = wards.find((w) => w.ward_code === wardCode);
    return ward ? (ward.kindoo_site_id ?? null) : null;
  };
  // Match by seat-level field when present; fall back to scope→ward
  // lookup so legacy seats (pre-migration) still classify.
  const grantSite = (
    grantKindooSiteId: string | null | undefined,
    grantScope: string,
  ): string | null => {
    if (grantKindooSiteId !== undefined && grantKindooSiteId !== null) {
      return grantKindooSiteId;
    }
    if (grantKindooSiteId === null) return null;
    return wardSite(grantScope);
  };

  const wantSiteId: string | null = activeSite.kind === 'home' ? null : activeSite.siteId;

  type Contributor = {
    scope: string;
    type: Seat['type'];
    callings: string[];
    reason: string | undefined;
    buildings: string[];
  };
  const contributors: Contributor[] = [];
  // Primary first (preserves "primary wins on scope/type" when it
  // matches the active site).
  if (grantSite(seat.kindoo_site_id, seat.scope) === wantSiteId) {
    contributors.push({
      scope: seat.scope,
      type: seat.type,
      callings: seat.callings ?? [],
      reason: seat.reason,
      buildings: seat.building_names ?? [],
    });
  }
  for (const dup of seat.duplicate_grants ?? []) {
    if (grantSite(dup.kindoo_site_id, dup.scope) !== wantSiteId) continue;
    contributors.push({
      scope: dup.scope,
      type: dup.type,
      callings: dup.callings ?? [],
      reason: dup.reason,
      // Within-site duplicates may leave `building_names` unset and
      // inherit from the ward's `building_name`. Parallel-site
      // duplicates always carry their own `building_names`.
      buildings: dup.building_names ?? wardBuildingsForScope(dup.scope, wards),
    });
  }
  if (contributors.length === 0) return null;
  const first = contributors[0]!;
  const unioned: string[] = [];
  const seen = new Set<string>();
  for (const c of contributors) {
    for (const b of c.buildings) {
      if (seen.has(b)) continue;
      seen.add(b);
      unioned.push(b);
    }
  }
  return {
    scope: first.scope,
    type: first.type,
    callings: first.callings,
    reason: first.reason,
    buildingNames: unioned,
  };
}

/** Lookup ward → its declared `building_name` (single string) → array
 *  for downstream union math. Returns an empty array when the ward
 *  isn't in the catalogue or carries no building. */
function wardBuildingsForScope(scope: string, wards: Ward[]): string[] {
  if (scope === 'stake') return [];
  const w = wards.find((x) => x.ward_code === scope);
  if (!w || !w.building_name) return [];
  return [w.building_name];
}

/**
 * T-42: pick the parsed segment whose scope's Kindoo site matches the
 * active site. Mirrors `pickPrimarySegment`'s `prefer auto > stake >
 * ward-alpha` tiebreaker but pre-filters by site. Returns `null` when
 * no segment resolves to the active site.
 */
function pickSegmentForSite(
  parsed: ParsedDescription,
  sets: CallingTemplateSets,
  stake: Stake,
  wards: Ward[],
  activeSite: ActiveSite | undefined,
): ParsedSegment | null {
  if (!activeSite || activeSite.kind === 'unknown') return null;
  const wantSiteId: string | null = activeSite.kind === 'home' ? null : activeSite.siteId;
  const segmentSite = (segment: ParsedSegment): string | null | undefined => {
    if (!segment.resolvedScope || segment.scope === null) return undefined;
    if (segment.scope === 'stake') return null; // stake-scope is home-only.
    const w = wards.find((x) => x.ward_code === segment.scope);
    return w ? (w.kindoo_site_id ?? null) : undefined;
  };
  const filtered = parsed.segments.filter((s) => segmentSite(s) === wantSiteId);
  if (filtered.length === 0) return null;
  // Reuse `pickPrimarySegment`'s tiebreaker by wrapping the filter in
  // a ParsedDescription shell (`raw` / `unparseable` aren't used by
  // the picker).
  return pickPrimarySegment({ segments: filtered, unparseable: false, raw: parsed.raw }, sets);
}

/**
 * Map Kindoo rule IDs back to SBA building names via
 * `building.kindoo_rule.rule_id`. Rules with no matching SBA building
 * surface as `'(unknown rule X)'` for the report.
 */
function ruleIdsToBuildingNames(ruleIds: number[], buildings: Building[]): string[] {
  const out: string[] = [];
  for (const rid of ruleIds) {
    const b = buildings.find((bldg) => bldg.kindoo_rule?.rule_id === rid);
    out.push(b ? b.building_name : `(unknown rule ${rid})`);
  }
  return out;
}

/** True iff two string sets are equal regardless of order or duplicates. */
function setsEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) {
    // Count-distinct compare; some duplicate rules could repeat.
    const sa = new Set(a);
    const sb = new Set(b);
    if (sa.size !== sb.size) return false;
    for (const v of sa) if (!sb.has(v)) return false;
    return true;
  }
  const sa = new Set(a);
  for (const v of b) if (!sa.has(v)) return false;
  return true;
}

/**
 * Grant-based provenance predicate (Guest seats only): a seat is
 * "church-backed" iff the member holds **at least one** Church Access
 * Automation DIRECT grant. The seat's own building set no longer enters
 * this decision — ANY church-direct grant means the church is
 * provisioning the user, so the seat is `auto`; zero church-direct
 * grants means every door is SBA-rule-provisioned, so `manual`.
 *
 *   - `directGrantBuildings === null` (derivation failed) → `false`
 *     ("can't determine" — caller leaves the type unchanged).
 *   - non-empty → `true` (auto): at least one church-direct grant.
 *   - `[]` → `false` (manual): zero church-direct grants.
 *
 * (Building-set coverage still matters for `buildings-mismatch`; that
 * path is unaffected by this change.)
 *
 * Pure function — no I/O.
 */
export function isChurchBacked(directGrantBuildings: string[] | null): boolean {
  return directGrantBuildings !== null && directGrantBuildings.length > 0;
}

/**
 * The Guest seat-type decision: a seat is `auto` (church-owned
 * provisioning) iff the member holds at least one church-direct grant.
 * Identical to `isChurchBacked` under the "any church-direct grant"
 * rule; kept as a distinct export for the create / promote call sites
 * (vs `isChurchBacked` at the demote site).
 *
 * Pure function — no I/O.
 */
export function grantsBackAuto(directGrantBuildings: string[] | null): boolean {
  return isChurchBacked(directGrantBuildings);
}

/**
 * The FULL set of calling(s) Kindoo's primary parens text
 * (`Calling A, Calling B`) names — the target an auto seat's
 * `callings[]` must MIRROR (Kindoo authoritative). Split on `,`, trim
 * each, drop empties, de-dupe (case-insensitively so a calling repeated
 * in the parens appears once). The returned strings preserve Kindoo's
 * original casing / spelling so the seat ends up labelled exactly as
 * Kindoo describes it.
 *
 * Pure function — no I/O.
 */
export function parseKindooCallings(parenText: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of parenText.split(',')) {
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

/**
 * Order-independent, case/whitespace-normalized set compare for
 * callings. Two lists are equal when they carry the same normalized
 * (trimmed + lowercased) members, regardless of order, casing, padding,
 * or duplicates. Drives the `callings-mismatch` "do they differ?"
 * decision in either direction.
 *
 * Pure function — no I/O.
 */
function callingSetsEqual(a: string[], b: string[]): boolean {
  const norm = (xs: string[]): Set<string> => new Set(xs.map((x) => x.trim().toLowerCase()));
  const sa = norm(a);
  const sb = norm(b);
  if (sa.size !== sb.size) return false;
  for (const v of sa) if (!sb.has(v)) return false;
  return true;
}

/**
 * Home-site predicate for the present-but-unparseable gate. "Apply to
 * stake scope" is a home-site / stake concept — on a foreign Kindoo site
 * it's meaningless, so `kindoo-unparseable` is suppressed there entirely.
 *
 * `undefined` (no active-site context — pre-Phase-4 callers / tests that
 * don't filter) is treated as home-eligible so legacy behaviour is
 * preserved. `unknown` short-circuits the whole detect to an empty diff
 * upstream, so it never reaches this predicate; for completeness it is
 * NOT home.
 */
function isHomeSite(activeSite: ActiveSite | undefined): boolean {
  if (!activeSite) return true;
  return activeSite.kind === 'home';
}

/** Case/whitespace-normalized compare of two strings. */
function eqNormalized(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Is the SBA seat ALREADY in the state the present-but-unparseable
 * Update-SBA action would produce? When true, there's no drift — the
 * actionable `kindoo-unparseable` row is suppressed so it resolves on the
 * next run like every other drift code.
 *
 * "Aligned" = the seat is at stake scope AND the calling text (raw Kindoo
 * description, trimmed) is recorded per the §6.1 seat shape:
 *   - auto         → `callings` equals `[<rawDescription>]`.
 *   - manual / temp → `reason === <rawDescription>` and `callings` empty.
 * Comparison is case/whitespace-normalized. `kindoo_site_id` is not
 * checked — the backend clears it when forcing stake scope.
 *
 * Pure function — no I/O.
 */
function unparseableAligned(sba: SbaBlock, rawDescription: string): boolean {
  const calling = rawDescription.trim();
  if (calling.length === 0) return false;
  if (sba.scope !== 'stake') return false;
  if (sba.type === 'auto') {
    return sba.callings.length === 1 && eqNormalized(sba.callings[0]!, calling);
  }
  // manual / temp — calling lives in `reason`, callings cleared.
  return sba.callings.length === 0 && eqNormalized(sba.reason ?? '', calling);
}

// ============================================================
// Kindoo role (DepartmentType) — per-role seat-type branch
// ============================================================
//
// Kindoo's `DepartmentType` field is a role enum present on every bulk
// environment-user record (verified against live Colorado Springs North
// data). The Sync detector branches its seat-type decision on it:
//   - Administrator / Manager → force `type = auto`
//   - Guest                   → grant-based classification (#188)
//   - Installer               → 3rd-party vendor; skip entirely
//
// Live values: Guests = 2 (gossbc + ~320 members); Administrators = 0;
// Managers = 1; Installers = 3 (ryan.gard, greagmills).

const DEPT_ADMINISTRATOR = 0;
const DEPT_MANAGER = 1;
const DEPT_GUEST = 2;
const DEPT_INSTALLER = 3;

/**
 * Detector role bucket. Administrator and Manager collapse to `admin`
 * because they share the same treatment (force `auto`); the distinct
 * `DEPT_*` constants keep the enum self-documenting.
 */
export type KindooRole = 'guest' | 'admin' | 'installer';

/**
 * Map a Kindoo user's `DepartmentType` enum to the detector role bucket.
 *
 *   - `3` (Installer) → `'installer'` — skipped entirely by the loop.
 *   - `2` (Guest)     → `'guest'`     — grant-based classification.
 *   - `0`/`1` (Administrator / Manager) → `'admin'` — force `auto`.
 *   - `undefined` / missing → `'guest'` (conservative: don't force-auto
 *     or skip a user whose role we couldn't read).
 *   - any other concrete non-2/non-3 number → `'admin'` (force `auto`),
 *     matching the Administrator/Manager treatment.
 *
 * Pure function — no I/O.
 */
export function kindooRole(kuser: KindooEnvironmentUser): KindooRole {
  const dept = kuser.DepartmentType;
  if (dept === undefined) return 'guest';
  if (dept === DEPT_INSTALLER) return 'installer';
  if (dept === DEPT_GUEST) return 'guest';
  if (dept === DEPT_ADMINISTRATOR || dept === DEPT_MANAGER) return 'admin';
  // Any other concrete non-2/non-3 number defaults to the force-auto
  // (Administrator / Manager) treatment.
  return 'admin';
}

/** Sort comparator for the final report. */
function compareDiscrepancies(a: Discrepancy, b: Discrepancy): number {
  // drift first, then review.
  if (a.severity !== b.severity) return a.severity === 'drift' ? -1 : 1;
  return a.displayEmail.localeCompare(b.displayEmail);
}

/**
 * Run the full discrepancy detection. Returns the sorted row list plus
 * the two counters that surface in the report header.
 */
export function detect(inputs: DetectInputs): DetectResult {
  const sets = buildCallingTemplateSets(
    inputs.stakeCallingTemplates,
    inputs.wardCallingTemplates,
    inputs.wards.map((w) => w.ward_code),
  );

  // Active-site filter: scope the union of (seats, kindoo users) to
  // grants belonging to the active Kindoo site. `unknown` returns an
  // empty diff up front (the panel renders an empty-state recovery
  // message instead).
  //
  // T-42: per-site fan-out. A seat is visible on the active site when
  // ANY of (primary, duplicate_grants[]) targets that site; a Kindoo
  // user is visible on the active site when ANY parsed segment
  // resolves to a scope on that site. Pre-T-42 the active-site filter
  // keyed off the seat's primary scope and the parsed primary segment
  // alone; that collapsed a multi-site Description down to one site
  // and lost the user's visibility on the other site.
  if (inputs.activeSite && inputs.activeSite.kind === 'unknown') {
    return {
      discrepancies: [],
      seatCount: 0,
      kindooCount: 0,
    };
  }

  // Project each seat onto the active site (primary if its
  // `kindoo_site_id` matches; else any same-site duplicate). Seats
  // with no grant on the active site are filtered out — they belong
  // to a different site's manager view.
  type ProjectedSeat = { seat: Seat; sbaBlock: SbaBlock };
  const projectedSeats: ProjectedSeat[] = [];
  for (const seat of inputs.seats) {
    if (!inputs.activeSite) {
      // No active-site context — preserve pre-T-42 behaviour (don't
      // filter; project against the seat's primary fields directly).
      projectedSeats.push({ seat, sbaBlock: toSbaBlock(seat) });
      continue;
    }
    const projected = projectSeatForSite(seat, inputs.wards, inputs.activeSite);
    if (projected) projectedSeats.push({ seat, sbaBlock: projected });
  }
  const filteredKindooUsers = filterKindooUsersByActiveSite(
    inputs.kindooUsers,
    inputs.stake,
    inputs.wards,
    sets,
    inputs.activeSite,
  );

  const seatsByEmail = new Map<string, ProjectedSeat>();
  for (const p of projectedSeats) seatsByEmail.set(p.seat.member_canonical, p);
  const kindooByEmail = indexKindooUsers(filteredKindooUsers);

  const allCanonical = new Set<string>([...seatsByEmail.keys(), ...kindooByEmail.keys()]);
  const discrepancies: Discrepancy[] = [];

  // T-42: when an active-site is set, primary segment for the Kindoo
  // side is the one whose scope resolves to that site (not whichever
  // segment wins the unfiltered `pickPrimarySegment` race). The
  // SBA-side `sbaBlock` is already projected onto the active site.
  const pickRelevantSegment = (parsed: ParsedDescription): ParsedSegment | null => {
    if (inputs.activeSite) {
      return pickSegmentForSite(parsed, sets, inputs.stake, inputs.wards, inputs.activeSite);
    }
    return pickPrimarySegment(parsed, sets);
  };

  for (const canon of allCanonical) {
    const projected = seatsByEmail.get(canon) ?? null;
    const seat = projected?.seat ?? null;
    const sbaBlock = projected?.sbaBlock ?? null;
    const kuser = kindooByEmail.get(canon) ?? null;
    const displayEmail = kuser?.username ?? seat?.member_email ?? canon;

    // 1. sba-only — seat present, no Kindoo user. (No `kuser`, so the
    //    Installer skip below never applies here.)
    if (seat && sbaBlock && !kuser) {
      discrepancies.push({
        canonical: canon,
        displayEmail,
        code: 'sba-only',
        severity: 'drift',
        reason: 'SBA has a seat for this member, but the user is not present in Kindoo.',
        sba: sbaBlock,
        kindoo: null,
      });
      continue;
    }

    // Installer skip — a 3rd-party vendor (DepartmentType 3) produces
    // NO discrepancy rows of any kind (kindoo-only, type/buildings/
    // callings-mismatch, unparseable, scope-mismatch). Every remaining
    // branch involves a live `kuser`, so skipping here before any of
    // them suppresses all installer rows at once. `sba-only` already
    // returned above (it has no `kuser`).
    const role = kuser ? kindooRole(kuser) : 'guest';
    if (kuser && role === 'installer') continue;

    // 2. kindoo-only — Kindoo user present, no SBA seat.
    if (!seat && kuser) {
      const parsed = parseDescription(kuser.description, inputs.stake, inputs.wards);
      const primary = pickRelevantSegment(parsed);
      const intended = primary ? classifySegment(primary, kuser.isTempUser, sets) : null;
      // Grant-derived type for the seat we'd create:
      //   - temp wins (`IsTempUser`-driven).
      //   - Admin (Administrator / Manager) → `auto` regardless of grant
      //     backing (non-Guest role ⇒ SBA treats the seat as church-owned).
      //   - Guest → `auto` when the member holds ANY church-direct grant
      //     (`grantsBackAuto`); else `manual`. The seat's building set no
      //     longer enters this decision — a single church-direct grant is
      //     enough. A null derivation falls through to `manual` (the
      //     born-manual default; we don't mint auto on unknown provenance).
      const createdType: SeatType = kuser.isTempUser
        ? 'temp'
        : role === 'admin'
          ? 'auto'
          : grantsBackAuto(kuser.directGrantBuildings ?? null)
            ? 'auto'
            : 'manual';
      discrepancies.push({
        canonical: canon,
        displayEmail,
        code: 'kindoo-only',
        severity: 'drift',
        reason: 'Kindoo has a user for this email, but SBA has no seat for them.',
        sba: null,
        kindoo: buildKindooBlock(kuser, parsed, intended, inputs.buildings, sets, createdType),
      });
      continue;
    }

    // From here both sides exist.
    if (!seat || !sbaBlock || !kuser) continue;

    const parsed = parseDescription(kuser.description, inputs.stake, inputs.wards);

    // Admin (Administrator / Manager) force-auto — HOISTED above the
    // description-resolve / unparseable section. The seat's type is `auto`
    // regardless of grant backing OR whether the description parses.
    // Managers typically carry unparseable descriptions; if the
    // unparseable-aligned short-circuit (or the foreign-site / no-primary
    // branches) ran first, a manual admin seat would stay `manual`
    // forever. So promote here, before any of that:
    //   - non-auto, non-temp admin seat → PROMOTE to `auto`, then continue.
    //   - already-auto (or temp) admin seat → fall through, so an
    //     already-auto admin with an unparseable description still gets the
    //     `unparseable → stake` / scope / buildings reconciliation.
    if (role === 'admin' && sbaBlock.type !== 'auto' && sbaBlock.type !== 'temp') {
      discrepancies.push({
        canonical: canon,
        displayEmail,
        code: 'type-mismatch',
        severity: 'drift',
        reason:
          'Promote to auto: this Kindoo user is an Administrator/Manager (non-Guest), so the seat is church-owned ⇒ auto.',
        sba: sbaBlock,
        kindoo: buildKindooBlock(kuser, parsed, null, inputs.buildings, sets, 'auto'),
      });
      continue;
    }

    // 3. Description doesn't resolve. Two cases — split on whether any
    //    text is present:
    //
    //    a) Blank (`segments.length === 0`) — nothing to reconcile. The
    //       ONE always-review code: no SBA-side action can be derived from
    //       an empty description. `kindoo-no-description`, `review`.
    //
    //    b) Present-but-unparseable (`segments.length > 0`, none resolve)
    //       — text exists but doesn't match `Scope (Calling)`. We treat it
    //       as a church-wide (stake-scope) calling and Update SBA for
    //       EVERYONE (all seat roles — managers can hold seats too). Two
    //       gates, in order:
    //         A) Home-site only. "Apply to stake scope" is a home/stake
    //            concept; suppress the row entirely on a foreign site.
    //         B) Already aligned → no drift. When the SBA seat is already
    //            in the state Update SBA would produce (stake scope +
    //            calling recorded per type), suppress the row so it
    //            resolves like every other drift code.
    //       The kindoo block stays populated so the dispatcher can read
    //       the raw description.
    if (parsed.unparseable) {
      if (parsed.segments.length === 0) {
        discrepancies.push({
          canonical: canon,
          displayEmail,
          code: 'kindoo-no-description',
          severity: 'review',
          reason: 'Kindoo description is blank — nothing to reconcile; manual review.',
          sba: sbaBlock,
          kindoo: buildKindooBlock(kuser, parsed, null, inputs.buildings, sets),
        });
        continue;
      }
      // A) Foreign site → no unparseable row at all.
      if (!isHomeSite(inputs.activeSite)) continue;
      // B) Already aligned with the stake-scope target → no drift.
      if (unparseableAligned(sbaBlock, kuser.description)) continue;
      discrepancies.push({
        canonical: canon,
        displayEmail,
        code: 'kindoo-unparseable',
        severity: 'drift',
        reason:
          "Kindoo description doesn't match 'Scope (Calling)'; treat as a stake-scope (church-wide) calling and Update SBA.",
        sba: sbaBlock,
        kindoo: buildKindooBlock(kuser, parsed, null, inputs.buildings, sets),
      });
      continue;
    }

    const primary = pickRelevantSegment(parsed);
    if (!primary) {
      // Shouldn't be reachable when unparseable=false and the filter
      // already kept this user, but be defensive. Here the description DID
      // parse (it carries scope + parens, e.g. "Maple Ward (Bishop)") —
      // routing it to Update SBA would send that whole string as the
      // `calling` and corrupt the seat. Emit `review` (no action via the
      // fixActionsFor review guard) instead.
      discrepancies.push({
        canonical: canon,
        displayEmail,
        code: 'kindoo-unparseable',
        severity: 'review',
        reason: 'Kindoo description has no resolvable primary segment; review manually.',
        sba: sbaBlock,
        kindoo: buildKindooBlock(kuser, parsed, null, inputs.buildings, sets),
      });
      continue;
    }
    const intended = classifySegment(primary, kuser.isTempUser, sets);

    // 5. scope-mismatch — parsed primary scope differs from seat.scope.
    if (intended.scope !== sbaBlock.scope) {
      discrepancies.push({
        canonical: canon,
        displayEmail,
        code: 'scope-mismatch',
        severity: 'drift',
        reason: `Primary scope differs: SBA=${sbaBlock.scope}, Kindoo=${intended.scope ?? '(unresolved)'}.`,
        sba: sbaBlock,
        kindoo: buildKindooBlock(kuser, parsed, intended, inputs.buildings, sets),
      });
      continue;
    }

    // 6. type-mismatch — Guest grant-based PROMOTE / DEMOTE (#188).
    //
    // Admin (Administrator / Manager) force-auto is HOISTED above the
    // description-resolve section (a non-auto admin already promoted +
    // continued; an already-auto admin fell through to here, where
    // `sbaBlock.type === 'auto'` can't promote / demote anyway). So this
    // block is effectively Guest-only — explicitly gated `role ===
    // 'guest'` for clarity.
    //
    // `type` is a provenance label: who owns the Kindoo grant — the
    // church (`auto`, SBA writes no rule) or SBA (`manual`). We observe
    // provenance from the member's Church Access Automation DIRECT
    // grants (`directGrantBuildings`), NOT from the calling-template
    // classifier (which is a guess at churchwide behaviour and drifts).
    //
    // The test is "ANY church-direct grant" — the seat's own building set
    // no longer enters the decision (it still drives `buildings-mismatch`
    // below):
    //   - manual seat + ≥1 church-direct grant → PROMOTE to `auto`.
    //   - auto seat + ZERO church-direct grants → DEMOTE to `manual`.
    //   - directGrantBuildings === null (derivation failed) → skip;
    //     can't determine provenance (leave the type unchanged — never
    //     demote on unknown provenance).
    //   - temp seats are never promoted / demoted — `temp` is
    //     `IsTempUser`-driven, orthogonal to grant provenance.
    const directGrant = kuser.directGrantBuildings ?? null;
    if (role === 'guest' && sbaBlock.type !== 'temp' && directGrant !== null) {
      // `directGrant !== null` here, so `isChurchBacked` reduces to
      // "≥1 church-direct grant". DEMOTE fires only on the empty set —
      // never on `null` (excluded by the guard).
      const churchBacked = isChurchBacked(directGrant);
      if (sbaBlock.type === 'manual' && churchBacked) {
        // PROMOTE — the member holds at least one church-direct grant, so
        // the church owns provisioning ⇒ auto.
        const directList = directGrant.length > 0 ? directGrant.join(', ') : '(none)';
        discrepancies.push({
          canonical: canon,
          displayEmail,
          code: 'type-mismatch',
          severity: 'drift',
          reason: `Promote to auto: the church directly grants door access for this member (church-direct building(s) [${directList}]), so Kindoo provisioning is church-owned.`,
          sba: sbaBlock,
          kindoo: buildKindooBlock(kuser, parsed, intended, inputs.buildings, sets, 'auto'),
        });
        continue;
      }
      if (sbaBlock.type === 'auto' && !churchBacked) {
        // DEMOTE — the member holds ZERO church-direct grants (all access
        // is SBA-rule-provisioned), so SBA must own them ⇒ manual.
        discrepancies.push({
          canonical: canon,
          displayEmail,
          code: 'type-mismatch',
          severity: 'drift',
          reason:
            'Demote to manual: the church no longer directly grants any door access for this member; SBA owns the access ⇒ manual.',
          sba: sbaBlock,
          kindoo: buildKindooBlock(kuser, parsed, intended, inputs.buildings, sets, 'manual'),
        });
        continue;
      }
    }

    // 7. buildings-mismatch — Kindoo door-access truth vs SBA building set.
    //
    // `derivedBuildings` (the per-door grant strict-subset chain, stamped
    // onto `kuser` by `sync/buildingsFromDoors.ts` BEFORE detect()) is the
    // authoritative Kindoo door-access signal for ALL seat types: it sees
    // both Church Access Automation direct grants AND rule-based grants.
    // The bulk listing's AccessSchedules array misses direct grants, so it
    // is only a fallback for manual/temp when derivation failed (`null`).
    // For auto when derivation failed, leave the compare set `null` so the
    // check is skipped — unchanged auto behavior.
    //
    // Grant reconciliation applies to ALL seat roles (managers can hold
    // seats); the only skip is "can't classify" — `derivedBuildings ===
    // null` for auto (and no manual/temp AccessSchedules fallback).
    let kindooBuildingsForCompare: string[] | null = null;
    if (kuser.derivedBuildings !== null && kuser.derivedBuildings !== undefined) {
      kindooBuildingsForCompare = kuser.derivedBuildings;
    } else if (intended.type === 'manual' || intended.type === 'temp') {
      kindooBuildingsForCompare = ruleIdsToBuildingNames(
        kuser.accessSchedules.map((s) => s.ruleId),
        inputs.buildings,
      );
    }
    if (kindooBuildingsForCompare !== null) {
      const expectedBuildings = sbaBlock.buildingNames;
      if (!setsEqual(expectedBuildings, kindooBuildingsForCompare)) {
        discrepancies.push({
          canonical: canon,
          displayEmail,
          code: 'buildings-mismatch',
          severity: 'drift',
          reason: `Building access differs: SBA=[${expectedBuildings.join(', ')}], Kindoo=[${kindooBuildingsForCompare.join(', ')}].`,
          sba: sbaBlock,
          kindoo: buildKindooBlock(kuser, parsed, intended, inputs.buildings, sets),
        });
        continue;
      }
    }

    // 8. callings-mismatch — AUTO seats only. An auto seat's `callings[]`
    // must MIRROR Kindoo's parsed primary calling(s) (Kindoo is
    // authoritative for the calling label). When the two differ as
    // normalized sets — in EITHER direction (Kindoo renamed, added, or
    // dropped a calling) — propose replacing the seat's `callings[]` with
    // Kindoo's full target set. Compare trimmed + case-insensitively, so
    // ordering / casing / padding differences never fire.
    //
    // Guard: only emit when Kindoo's target set is NON-EMPTY. The callable
    // rejects an empty `callings`; "Kindoo has a scope but no calling" is
    // not a callings-mismatch — it's left to the other codes / no row.
    //
    // Manual / temp seats are deliberately NOT checked: they record their
    // calling in the free-text `reason`, which is frequently operator
    // prose ("Requested by bishop", "Visiting speaker") rather than a
    // calling name — comparing against it would flood the review list
    // with non-actionable rows on every existing manual seat (operator
    // decision 2026-05-30). The `syncApplyFix` callings-mismatch path
    // REPLACES `callings[]`, which is the auto-seat shape anyway.
    if (sbaBlock.type === 'auto') {
      const kindooCallings = parseKindooCallings(primary.calling);
      if (kindooCallings.length > 0 && !callingSetsEqual(kindooCallings, sbaBlock.callings)) {
        const seatLabel = sbaBlock.callings.length > 0 ? sbaBlock.callings.join(', ') : '(none)';
        discrepancies.push({
          canonical: canon,
          displayEmail,
          code: 'callings-mismatch',
          severity: 'drift',
          reason: `Kindoo lists calling(s) [${kindooCallings.join(', ')}]; the seat has [${seatLabel}] — update SBA to match Kindoo.`,
          sba: sbaBlock,
          kindoo: buildKindooBlock(
            kuser,
            parsed,
            intended,
            inputs.buildings,
            sets,
            undefined,
            kindooCallings,
          ),
        });
        continue;
      }
    }
    // No discrepancy — skip.
  }

  discrepancies.sort(compareDiscrepancies);
  return {
    discrepancies,
    seatCount: projectedSeats.length,
    kindooCount: filteredKindooUsers.length,
  };
}

/**
 * T-42: keep Kindoo users with ANY parsed segment whose scope resolves
 * to the active Kindoo site. Pre-T-42 the filter looked at the
 * unfiltered `pickPrimarySegment` result and collapsed a multi-site
 * Description down to one site; that lost the user's visibility on
 * the other site.
 *
 * Unparseable / unresolvable Kindoo users:
 *   - Home site: keep so the historical `kindoo-only` /
 *     `kindoo-unparseable` rows still surface.
 *   - Foreign site: drop — we can't claim the user without a resolved
 *     scope, and if they belonged to OUR foreign-site wards they'd
 *     already have a seat (the seat side short-circuits).
 *
 * Backwards compat: when no `activeSite` is passed, return every
 * user. Pre-Phase-4 callers (older tests) rely on this.
 */
function filterKindooUsersByActiveSite(
  users: KindooEnvironmentUser[],
  stake: Stake,
  wards: Ward[],
  sets: CallingTemplateSets,
  activeSite: ActiveSite | undefined,
): KindooEnvironmentUser[] {
  if (!activeSite) return users;
  if (activeSite.kind === 'unknown') return [];
  return users.filter((u) => {
    const parsed = parseDescription(u.description, stake, wards);
    // Find ANY segment whose scope sits on the active site.
    const matched = pickSegmentForSite(parsed, sets, stake, wards, activeSite);
    if (matched) return true;
    // No matching segment. Preserve historical "show unparseable users
    // on home" behaviour: if home AND every segment is unresolved,
    // keep so `kindoo-only` / `kindoo-unparseable` still surfaces.
    if (activeSite.kind !== 'home') return false;
    const anyResolved = parsed.segments.some((s) => s.resolvedScope);
    return !anyResolved;
  });
}

// Re-export `DuplicateGrant` for callers that import via the detector
// barrel; surfaces typing parity with `Seat`.
export type { DuplicateGrant };

function buildKindooBlock(
  kuser: KindooEnvironmentUser,
  parsed: ParsedDescription,
  intended: IntendedSeatShape | null,
  buildings: Building[],
  sets: CallingTemplateSets,
  /** Grant-derived target type for promote / demote `type-mismatch`
   * rows; carried onto the block so the fix dispatcher sends the
   * observed-provenance target, not the template-derived `intendedType`. */
  grantTargetType?: SeatType,
  /** Full Kindoo target calling set for `callings-mismatch` rows; carried
   * so the fix dispatcher sources the REPLACE `callings` from the parser,
   * not a delta. */
  kindooCallings?: string[],
): KindooBlock {
  const primary = pickPrimarySegment(parsed, sets);
  const ruleIds = kuser.accessSchedules.map((s) => s.ruleId);
  const block: KindooBlock = {
    description: kuser.description,
    isTempUser: kuser.isTempUser,
    memberName: deriveMemberName(kuser),
    primaryScope: primary?.scope ?? null,
    intendedType: intended?.type ?? null,
    intendedCallings: intended?.callings ?? [],
    intendedFreeText: intended?.freeText ?? '',
    ruleIds,
    buildingNames: ruleIdsToBuildingNames(ruleIds, buildings),
    derivedBuildings: kuser.derivedBuildings ?? null,
    directGrantBuildings: kuser.directGrantBuildings ?? null,
  };
  if (grantTargetType !== undefined) block.grantTargetType = grantTargetType;
  if (kindooCallings !== undefined) block.kindooCallings = kindooCallings;
  if (kuser.isTempUser) {
    const start = toIsoDate(kuser.startAccessDoorsDateAtTimeZone);
    const end = toIsoDate(kuser.expiryDateAtTimeZone);
    if (start) block.startDate = start;
    if (end) block.endDate = end;
  }
  return block;
}

/**
 * Derive a display name from the Kindoo user record. Kindoo's bulk
 * listing returns `FirstName` / `LastName` for most users; fall back to
 * the username when both are absent so callers always have a non-empty
 * string (the `memberName` field on `kindoo-only` payloads is required
 * server-side).
 */
function deriveMemberName(kuser: KindooEnvironmentUser): string {
  const first = typeof kuser.FirstName === 'string' ? kuser.FirstName.trim() : '';
  const last = typeof kuser.LastName === 'string' ? kuser.LastName.trim() : '';
  const joined = [first, last].filter((s) => s.length > 0).join(' ');
  if (joined.length > 0) return joined;
  const displayName = typeof kuser.DisplayName === 'string' ? kuser.DisplayName.trim() : '';
  if (displayName.length > 0) return displayName;
  return kuser.username;
}

/**
 * Strip the time component off Kindoo's `YYYY-MM-DDTHH:MM` date strings.
 * Returns `null` when the input is falsy or doesn't match the expected
 * shape; the caller decides whether to omit the field entirely.
 */
function toIsoDate(value: string | null | undefined): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(value);
  return match ? match[1]! : null;
}
