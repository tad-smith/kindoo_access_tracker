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
import { KINDOO_GUEST_ROLE, type KindooEnvironmentUser } from '../endpoints';
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
  | 'extra-kindoo-calling';

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
   * Buildings the user holds via Church Access Automation **direct
   * grants only** (`AccessScheduleID === 0`). Drives the grant-based
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
   * Callings Kindoo's primary segment names that the SBA seat's
   * `callings[]` lacks (trimmed, case-insensitive diff). Set ONLY on
   * `extra-kindoo-calling` rows; undefined elsewhere. The fix
   * dispatcher sends THIS as the callable's `extraCallings`. Sourced
   * from the parser, not the retired auto-calling classifier.
   */
  extraKindooCallings?: string[];
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
 * Grant-based provenance predicate: a seat is "church-backed" iff
 * EVERY one of its building names is present in the member's
 * direct-grant building set. Conservative — partial coverage on a
 * multi-building seat is NOT church-backed (surface for review rather
 * than guess). Returns `false` when `directGrantBuildings === null`
 * (derivation failed — caller treats that as "can't determine").
 *
 * A seat with no building names is vacuously church-backed when the
 * direct-grant set is known: there are no doors the church must own,
 * so provenance can't argue against `auto`. (In practice a typed seat
 * always carries at least one building.)
 *
 * Pure function — no I/O.
 */
export function isChurchBacked(
  seatBuildingNames: string[],
  directGrantBuildings: string[] | null,
): boolean {
  if (directGrantBuildings === null) return false;
  const direct = new Set(directGrantBuildings);
  return seatBuildingNames.every((b) => direct.has(b));
}

/**
 * The seat-type decision: a seat is `auto` (church-owned provisioning)
 * iff it has **at least one building** AND every building is
 * direct-granted. The non-empty guard is the difference from
 * `isChurchBacked`'s raw set-subset (which is vacuously true for a
 * zero-building seat): a seat with no doors has no church-owned grant
 * to justify `auto`, so it stays `manual` (the born-manual default). A
 * zero-grant Kindoo user (newly added, access revoked) therefore is NOT
 * minted as an empty-building auto seat.
 *
 * Pure function — no I/O.
 */
export function grantsBackAuto(
  seatBuildingNames: string[],
  directGrantBuildings: string[] | null,
): boolean {
  return seatBuildingNames.length > 0 && isChurchBacked(seatBuildingNames, directGrantBuildings);
}

/**
 * THE single "is this user out of scope for grant-based reconciliation?"
 * decision. Both grant-derived checks — `type-mismatch` (promote/demote)
 * AND `buildings-mismatch` — consult this one predicate so they can
 * never disagree (guarding only one flips the user to the other's
 * spurious row). Returning `true` means: emit neither grant-based row
 * for this user.
 *
 * **The signal is the Kindoo seat role, and only that.** Grant-based
 * reconciliation applies ONLY to **Guests** (`UserRole ===
 * KINDOO_GUEST_ROLE`, i.e. 2 — the role SBA provisions seats as). Any
 * non-Guest is skipped: managers / admins are not SBA-owned door grants,
 * so their grant shape is none of our business. `userRole` is stamped
 * onto each user before `detect()` from a per-user call the sync already
 * makes (no extra request — see `KINDOO_GUEST_ROLE` in `endpoints.ts`).
 *
 * The motivating case is a Kindoo **Manager** whose Description parses
 * cleanly and matches an SBA auto seat (so Locked-in decision #6's
 * unparseable fall-through doesn't catch them — real staging case: a
 * Stake Clerk manager, `UserRole: 0`). A manager has no guest door
 * grants, so the church-direct-grant chain reads as "access revoked" and
 * would falsely demote — then, if only the demote were guarded, falsely
 * flag a `buildings-mismatch`.
 *
 * **`undefined` role → skip** (the safe default): `userRole` is read
 * from the door-grant rows (`endpoints.ts`), so a user with an EMPTY
 * `RulesList` — including a Guest whose church access was entirely
 * revoked — has no row to read it from and stays `undefined` ⇒ skip
 * (`undefined !== 2`). A failed door fetch is the same. This avoids the
 * false-demote on a user we can't classify and is consistent with the
 * per-check `directGrantBuildings === null` / `derivedBuildings === null`
 * skips.
 *
 * **Known trade-off (the role-from-door-rows limitation).** A real Guest
 * who has had ALL church access removed (zero door rows) is therefore
 * NOT demoted — the seat-type label stays `auto` even though SBA should
 * now own it. We accept this: the member already has no Kindoo door
 * access (only the label lags), and the alternative — a fallback role
 * source (a per-user `checkUserType`, or `UserRole` off the bulk
 * listing) for every zero-row seated user — is cost the manager-demote
 * fix doesn't warrant. A Guest with ANY remaining grant still carries
 * the role on its rows and demotes normally when those grants no longer
 * back the seat. Re-running Sync after the member is re-granted (or the
 * fallback is added later) resolves the lag.
 *
 * Pure function — no I/O.
 */
export function skipGrantReconciliation(kuser: Pick<KindooEnvironmentUser, 'userRole'>): boolean {
  return kuser.userRole !== KINDOO_GUEST_ROLE;
}

/**
 * Callings present in the Kindoo parens text (`Calling A, Calling B`)
 * but absent from the SBA seat's `callings[]`. Conservative,
 * false-positive-averse:
 *   - split on `,`, trim each, drop empties;
 *   - compare case-insensitively;
 *   - additive direction ONLY — a calling the seat HAS but Kindoo
 *     omits does not surface here (that's not an `extra-kindoo-calling`
 *     case);
 *   - de-dupe so a calling repeated in the parens reports once.
 * The returned strings preserve Kindoo's original casing / spelling so
 * the operator sees exactly what would be added.
 *
 * Pure function — no I/O.
 */
export function missingCallings(parenText: string, seatCallings: string[]): string[] {
  const seatSet = new Set(seatCallings.map((c) => c.trim().toLowerCase()));
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of parenText.split(',')) {
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    const key = trimmed.toLowerCase();
    if (seatSet.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

/**
 * Home-site predicate for the present-but-unparseable gate. "Apply to
 * stake scope" is a home-site / stake concept — on a foreign Kindoo site
 * it's meaningless, so `kindoo-unparseable` is suppressed there entirely
 * (both the actionable Guest variant and the review non-Guest variant).
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

    // 1. sba-only — seat present, no Kindoo user.
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

    // 2. kindoo-only — Kindoo user present, no SBA seat.
    if (!seat && kuser) {
      const parsed = parseDescription(kuser.description, inputs.stake, inputs.wards);
      const primary = pickRelevantSegment(parsed);
      const intended = primary ? classifySegment(primary, kuser.isTempUser, sets) : null;
      // Grant-derived type for the seat we'd create: temp wins
      // (`IsTempUser`-driven); otherwise grant-backed → auto, else
      // manual. Evaluated against the building set the new seat would
      // carry — `derivedBuildings` when known, else the AccessSchedules
      // fallback (matches the fix dispatcher's building source). A null
      // derivation or a zero-building set can't be grant-backed
      // (`grantsBackAuto` requires ≥1 building), so a zero-grant Kindoo
      // user falls through to the born-manual default rather than
      // minting an empty-building auto seat.
      const newSeatBuildings =
        kuser.derivedBuildings !== null && kuser.derivedBuildings !== undefined
          ? kuser.derivedBuildings
          : ruleIdsToBuildingNames(
              kuser.accessSchedules.map((s) => s.ruleId),
              inputs.buildings,
            );
      const createdType: SeatType = kuser.isTempUser
        ? 'temp'
        : grantsBackAuto(newSeatBuildings, kuser.directGrantBuildings ?? null)
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

    // 3. Description doesn't resolve. Two cases — split on whether any
    //    text is present:
    //
    //    a) Blank (`segments.length === 0`) — nothing to reconcile. The
    //       ONE always-review code: no SBA-side action can be derived from
    //       an empty description. `kindoo-no-description`, `review`.
    //
    //    b) Present-but-unparseable (`segments.length > 0`, none resolve)
    //       — text exists but doesn't match `Scope (Calling)`. We treat it
    //       as a church-wide (stake-scope) calling. Three gates, in order:
    //         A) Home-site only. "Apply to stake scope" is a home/stake
    //            concept; suppress the row entirely on a foreign site.
    //         B) Non-Guest (Kindoo Manager / admin) → emit `review` (FYI,
    //            no action). A manager isn't an SBA-owned grant; an
    //            actionable Update SBA would clobber their seat.
    //         C) Guest → actionable `drift`, BUT only when the SBA seat is
    //            not already in the state Update SBA would produce. Once
    //            aligned (stake scope + calling recorded per type), suppress
    //            the row so it resolves like every other drift code.
    //       The kindoo block stays populated either way so the dispatcher
    //       can read the raw description.
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
      // B) Non-Guest → review-only (no action via the fixActionsFor
      //    review guard); Guest → actionable.
      const reviewOnly = skipGrantReconciliation(kuser);
      // C) Guest already aligned with the stake-scope target → no drift.
      if (!reviewOnly && unparseableAligned(sbaBlock, kuser.description)) continue;
      discrepancies.push({
        canonical: canon,
        displayEmail,
        code: 'kindoo-unparseable',
        severity: reviewOnly ? 'review' : 'drift',
        reason: reviewOnly
          ? "Kindoo description doesn't match 'Scope (Calling)' and this is a non-Guest (Manager / admin); review manually."
          : "Kindoo description doesn't match 'Scope (Calling)'; treat as a stake-scope (church-wide) calling and Update SBA.",
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

    // The single out-of-scope decision for BOTH grant-based checks
    // (type-mismatch + buildings-mismatch). True ⇒ emit neither: a
    // non-Guest (Kindoo Manager / admin, `userRole !== 2`) is not an
    // SBA-owned door grant, so its grant shape is none of our business.
    // Scope-mismatch and the additive AUTO-only extra-kindoo-calling can
    // still fire — neither is grant-provenance reconciliation. See
    // `skipGrantReconciliation` for the full rationale.
    const skipGrantBased = skipGrantReconciliation(kuser);

    // 6. type-mismatch — grant-based PROMOTE / DEMOTE.
    //
    // `type` is a provenance label: who owns the Kindoo grant — the
    // church (`auto`, SBA writes no rule) or SBA (`manual`). We observe
    // provenance from the member's Church Access Automation DIRECT
    // grants (`directGrantBuildings`), NOT from the calling-template
    // classifier (which is a guess at churchwide behaviour and drifts).
    //
    //   - manual seat + church-backed → PROMOTE to `auto`.
    //   - auto seat + NOT church-backed → DEMOTE to `manual`.
    //   - directGrantBuildings === null (derivation failed) → skip;
    //     can't determine provenance, same as the buildings-null skip.
    //   - skipGrantReconciliation → skip; non-Guest (or role unknown),
    //     out of scope for grant-based reconciliation (see that predicate).
    //   - temp seats are never promoted / demoted — `temp` is
    //     `IsTempUser`-driven, orthogonal to grant provenance.
    const directGrant = kuser.directGrantBuildings ?? null;
    if (sbaBlock.type !== 'temp' && directGrant !== null && !skipGrantBased) {
      // PROMOTE requires a real grant-backed building (`grantsBackAuto`
      // is false for a zero-building seat). DEMOTE keys off the raw
      // subset (`!isChurchBacked`) so a degenerate zero-building auto
      // seat — vacuously church-backed — does NOT spuriously demote.
      const promoteToAuto = grantsBackAuto(sbaBlock.buildingNames, directGrant);
      const stillChurchBacked = isChurchBacked(sbaBlock.buildingNames, directGrant);
      if (sbaBlock.type === 'manual' && promoteToAuto) {
        // PROMOTE — the church grants every door of this seat's
        // buildings, so the church owns provisioning ⇒ auto.
        discrepancies.push({
          canonical: canon,
          displayEmail,
          code: 'type-mismatch',
          severity: 'drift',
          reason: `Promote to auto: the church directly grants every door for this seat's building(s) [${sbaBlock.buildingNames.join(', ') || '(none)'}], so Kindoo provisioning is church-owned.`,
          sba: sbaBlock,
          kindoo: buildKindooBlock(kuser, parsed, intended, inputs.buildings, sets, 'auto'),
        });
        continue;
      }
      if (sbaBlock.type === 'auto' && !stillChurchBacked) {
        // DEMOTE — the church no longer grants all of this seat's
        // doors, so SBA must own them ⇒ manual.
        const directList = directGrant.length > 0 ? directGrant.join(', ') : '(none)';
        discrepancies.push({
          canonical: canon,
          displayEmail,
          code: 'type-mismatch',
          severity: 'drift',
          reason: `Demote to manual: the church no longer directly grants all of this seat's building(s) [${sbaBlock.buildingNames.join(', ') || '(none)'}] (direct grants cover [${directList}]); SBA must own the access.`,
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
    // The grant-reconciliation skip short-circuits FIRST: a non-Guest
    // (Kindoo Manager, `userRole !== 2`) would otherwise compare
    // `derivedBuildings === []` against the seat's buildings and flag a
    // spurious `[buildings] vs []` mismatch — the exact false positive
    // guarding only the demote above would create. Their grant shape is
    // not "SBA's buildings are wrong"; skip.
    let kindooBuildingsForCompare: string[] | null = null;
    if (skipGrantBased) {
      kindooBuildingsForCompare = null;
    } else if (kuser.derivedBuildings !== null && kuser.derivedBuildings !== undefined) {
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

    // 8. extra-kindoo-calling — AUTO seats only. When Kindoo's parsed
    // primary segment names calling(s) the auto seat's roster
    // `callings[]` lacks, propose adding the missing one(s). Conservative
    // to avoid false positives: compare trimmed + case-insensitively,
    // additive direction only (Kindoo has callings the seat lacks);
    // never fire on ordering / formatting differences.
    //
    // Manual / temp seats are deliberately NOT checked: they record their
    // calling in the free-text `reason`, which is frequently operator
    // prose ("Requested by bishop", "Visiting speaker") rather than a
    // calling name — comparing against it would flood the review list
    // with non-actionable rows on every existing manual seat (operator
    // decision 2026-05-30). The `syncApplyFix` extra-kindoo-calling path
    // appends to `callings[]`, which is the auto-seat shape anyway.
    // Supersedes the old `intended.reviewMixed` trigger (tied to the
    // retired auto-calling classifier).
    if (sbaBlock.type === 'auto') {
      const extraCallings = missingCallings(primary.calling, sbaBlock.callings);
      if (extraCallings.length > 0) {
        const knownLabel = sbaBlock.callings.length > 0 ? sbaBlock.callings.join(', ') : '(none)';
        discrepancies.push({
          canonical: canon,
          displayEmail,
          code: 'extra-kindoo-calling',
          severity: 'drift',
          reason: `Kindoo lists calling(s) [${extraCallings.join(', ')}] beyond SBA's seat callings [${knownLabel}]; add the missing calling(s) to the SBA seat.`,
          sba: sbaBlock,
          kindoo: buildKindooBlock(
            kuser,
            parsed,
            intended,
            inputs.buildings,
            sets,
            undefined,
            extraCallings,
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
  /** Missing-calling diff for `extra-kindoo-calling` rows; carried so
   * the fix dispatcher sources `extraCallings` from the parser diff. */
  extraKindooCallings?: string[],
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
  if (extraKindooCallings !== undefined) block.extraKindooCallings = extraKindooCallings;
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
